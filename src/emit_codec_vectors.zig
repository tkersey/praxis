const std = @import("std");
const boundary = @import("boundary");
const praxis = @import("praxis_definition");

const Machine = praxis.Compiled.Machine;

const Emitter = struct {
    writer: *std.Io.Writer,
    allocator: std.mem.Allocator,
    first: bool = true,

    fn emit(
        self: *Emitter,
        name: []const u8,
        kind: []const u8,
        operation: ?[]const u8,
        comptime T: type,
        value: T,
    ) !void {
        const required = try boundary.schema.encodedSize(T, value);
        const encoded = try self.allocator.alloc(u8, required);
        defer self.allocator.free(encoded);
        _ = try boundary.schema.encode(T, value, encoded);
        if (!self.first) try self.writer.writeAll(",\n");
        self.first = false;
        try self.writer.print("    {{\"name\":\"{s}\",\"kind\":\"{s}\"", .{ name, kind });
        if (operation) |label| try self.writer.print(",\"operation\":\"{s}\"", .{label});
        try self.writer.writeAll(",\"hex\":\"");
        for (encoded) |byte| try self.writer.print("{x:0>2}", .{byte});
        try self.writer.writeAll("\"}");
    }
};

fn text(comptime T: type, value: []const u8) !T {
    return T.fromSlice(value);
}

fn digest(byte: u8) !praxis.DigestHex {
    var bytes = [_]u8{byte} ** 64;
    return text(praxis.DigestHex, &bytes);
}

fn snapshot(path_value: []const u8, digest_byte: u8, contents: []const u8) !praxis.DocumentSnapshot {
    return .{
        .path = try text(praxis.Path, path_value),
        .sha256 = try digest(digest_byte),
        .contents = try text(praxis.FileText, contents),
    };
}

fn listResult(entry_count: usize) !praxis.ListResult {
    var entries = praxis.ListedFiles.empty();
    for (0..entry_count) |index| {
        var path_buffer: [32]u8 = undefined;
        const path_value = try std.fmt.bufPrint(&path_buffer, "src/file-{d}.zig", .{index});
        try entries.push(.{
            .path = try text(praxis.Path, path_value),
            .size_bytes = @intCast(index + 1),
            .writable = index < 4,
        });
    }
    return .{ .entries = entries, .truncated = entry_count == praxis.maximum_listed_files };
}

fn searchResult(hit_count: usize) !praxis.SearchResult {
    var hits = praxis.SearchHits.empty();
    for (0..hit_count) |index| {
        var path_buffer: [32]u8 = undefined;
        const path_value = try std.fmt.bufPrint(&path_buffer, "src/file-{d}.zig", .{index});
        try hits.push(.{
            .path = try text(praxis.Path, path_value),
            .line = @intCast(index + 1),
            .excerpt = try text(praxis.ExcerptText, "literal match"),
        });
    }
    return .{ .hits = hits, .truncated = hit_count == praxis.maximum_search_hits };
}

fn changedFiles(count: usize) !praxis.ChangedFiles {
    var changed = praxis.ChangedFiles.empty();
    for (0..count) |index| {
        var path_buffer: [32]u8 = undefined;
        const path_value = try std.fmt.bufPrint(&path_buffer, "src/file-{d}.zig", .{index});
        try changed.push(try text(praxis.Path, path_value));
    }
    return changed;
}

fn mutation(path_value: []const u8, old: u8, new: u8) !praxis.MutationSummary {
    return .{
        .path = try text(praxis.Path, path_value),
        .old_sha256 = try digest(old),
        .new_sha256 = try digest(new),
        .already_applied = false,
    };
}

fn goal() !praxis.Goal {
    return .{
        .task = try text(praxis.TaskText, "Repair the admitted Zig fixture."),
        .repository = try text(praxis.RepositoryLabel, "tkersey/fixture"),
        .base_revision = try text(praxis.RevisionText, "0123456789abcdef0123456789abcdef01234567"),
    };
}

fn nextRequest(state: Machine.State) !Machine.Request {
    var fuel: u64 = 8_000_000;
    return switch (try Machine.step(state, &fuel)) {
        .request => |request| request,
        else => error.ExpectedRequest,
    };
}

fn resumeRequest(state: *Machine.State, request: Machine.Request, value: anytype) !void {
    const prepared = try Machine.prepareResume(state.*, request);
    defer Machine.deinitPreparedResume(prepared);
    try Machine.@"resume"(prepared, value);
}

fn drive(state: *Machine.State, action: praxis.Action, result: anytype) !void {
    const decision = try nextRequest(state.*);
    try resumeRequest(state, decision, action);
    const effect = try nextRequest(state.*);
    try resumeRequest(state, effect, result);
}

fn emitDecisionTurns(emitter: *Emitter) !void {
    var state = try Machine.initialState(emitter.allocator, try goal());
    defer Machine.deinitState(state);
    const initial = try nextRequest(state);
    switch (initial.value) {
        .s0 => |turn| try emitter.emit("decision_turn_empty", "decision_turn", null, @TypeOf(turn), turn),
        else => return error.ExpectedDecisionRequest,
    }

    const path0 = try text(praxis.Path, "src/file-0.zig");
    try resumeRequest(&state, initial, praxis.Action{ .list_repository = {} });
    const list_request = try nextRequest(state);
    try resumeRequest(&state, list_request, try listResult(2));
    try drive(&state, .{ .read_file = .{ .path = path0 } }, try snapshot("src/file-0.zig", 'a', "const value = 0;\n"));
    try drive(&state, .{ .search_text = .{
        .query = try text(praxis.QueryText, "value"),
        .path_prefix = try text(praxis.Path, "src"),
    } }, try searchResult(1));
    try drive(&state, .{ .run_tests = .{ .suite = .full } }, praxis.TestResult{
        .exit_code = 1,
        .passed = false,
        .output = try text(praxis.TestOutput, "check failed"),
        .truncated = false,
    });
    try drive(&state, .{ .replace_file = .{
        .path = path0,
        .expected_sha256 = try digest('a'),
        .replacement = try text(praxis.FileText, "const value = 1;\n"),
        .rationale = try text(praxis.SummaryText, "Correct the fixture value."),
    } }, praxis.ReplaceOutcome{ .applied = .{
        .path = path0,
        .old_sha256 = try digest('a'),
        .new_sha256 = try digest('b'),
        .already_applied = false,
        .current = try snapshot("src/file-0.zig", 'b', "const value = 1;\n"),
    } });
    const same_path = try nextRequest(state);
    switch (same_path.value) {
        .s0 => |turn| try emitter.emit("decision_turn_same_path", "decision_turn", null, @TypeOf(turn), turn),
        else => return error.ExpectedDecisionRequest,
    }

    try resumeRequest(&state, same_path, praxis.Action{ .run_tests = .{ .suite = .full } });
    const test_request = try nextRequest(state);
    try resumeRequest(&state, test_request, praxis.TestResult{
        .exit_code = 0,
        .passed = true,
        .output = try text(praxis.TestOutput, "all checks passed"),
        .truncated = false,
    });
    const path1 = try text(praxis.Path, "src/file-1.zig");
    try drive(&state, .{ .read_file = .{ .path = path1 } }, try snapshot("src/file-1.zig", 'c', "const other = 0;\n"));
    const multi_path = try nextRequest(state);
    switch (multi_path.value) {
        .s0 => |turn| try emitter.emit("decision_turn_multi_path", "decision_turn", null, @TypeOf(turn), turn),
        else => return error.ExpectedDecisionRequest,
    }
}

pub fn main(init: std.process.Init) !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var output_buffer: [64 * 1024]u8 = undefined;
    var file_writer = std.Io.File.stdout().writer(init.io, &output_buffer);
    var emitter = Emitter{ .writer = &file_writer.interface, .allocator = allocator };
    try emitter.writer.writeAll("{\n  \"format\":\"praxis-codec-vectors/v1\",\n  \"vectors\":[\n");

    try emitter.emit("action_list", "action", null, praxis.Action, .{ .list_repository = {} });
    try emitter.emit("action_read", "action", null, praxis.Action, .{ .read_file = .{ .path = try text(praxis.Path, "src/main.zig") } });
    try emitter.emit("action_search", "action", null, praxis.Action, .{ .search_text = .{ .query = try text(praxis.QueryText, "needle"), .path_prefix = try text(praxis.Path, "src") } });
    try emitter.emit("action_test", "action", null, praxis.Action, .{ .run_tests = .{ .suite = .full } });
    try emitter.emit("action_replace", "action", null, praxis.Action, .{ .replace_file = .{
        .path = try text(praxis.Path, "src/main.zig"), .expected_sha256 = try digest('a'),
        .replacement = try text(praxis.FileText, "const repaired = true;\n"), .rationale = try text(praxis.SummaryText, "Repair behavior."),
    } });
    const final_value = praxis.FinalResult{ .summary = try text(praxis.SummaryText, "Repaired and verified."), .changed_files = try changedFiles(2), .tests_passed = true, .mutation_count = 2 };
    try emitter.emit("action_final", "action", null, praxis.Action, .{ .final = final_value });
    try emitter.emit("action_abort", "action", null, praxis.Action, .{ .abort = .authored_abort });
    try emitter.emit("final_result", "final_result", null, praxis.FinalResult, final_value);

    try emitter.emit("payload_list", "payload", "list", void, {});
    try emitter.emit("payload_read", "payload", "read", praxis.ReadRequest, .{ .path = try text(praxis.Path, "src/main.zig") });
    try emitter.emit("payload_search", "payload", "search", praxis.SearchRequest, .{ .query = try text(praxis.QueryText, "needle"), .path_prefix = try text(praxis.Path, "src") });
    try emitter.emit("payload_test", "payload", "test", praxis.TestRequest, .{ .suite = .full });
    try emitter.emit("payload_replace", "payload", "replace", praxis.ReplaceRequest, .{
        .path = try text(praxis.Path, "src/main.zig"), .expected_sha256 = try digest('a'),
        .replacement = try text(praxis.FileText, "const repaired = true;\n"), .rationale = try text(praxis.SummaryText, "Repair behavior."),
    });

    try emitter.emit("result_list_empty", "result", "list", praxis.ListResult, try listResult(0));
    try emitter.emit("result_list_maximum", "result", "list", praxis.ListResult, try listResult(praxis.maximum_listed_files));
    try emitter.emit("result_read", "result", "read", praxis.ReadResult, try snapshot("src/main.zig", 'b', "const repaired = true;\n"));
    try emitter.emit("result_search_empty", "result", "search", praxis.SearchResult, try searchResult(0));
    try emitter.emit("result_search_maximum", "result", "search", praxis.SearchResult, try searchResult(praxis.maximum_search_hits));
    try emitter.emit("result_test_positive", "result", "test", praxis.TestResult, .{ .exit_code = 0, .passed = true, .output = try text(praxis.TestOutput, "all checks passed"), .truncated = false });
    try emitter.emit("result_test_negative", "result", "test", praxis.TestResult, .{ .exit_code = -7, .passed = false, .output = try text(praxis.TestOutput, "check failed"), .truncated = true });
    try emitter.emit("result_replace_applied", "result", "replace", praxis.ReplaceOutcome, .{ .applied = .{
        .path = try text(praxis.Path, "src/main.zig"), .old_sha256 = try digest('a'), .new_sha256 = try digest('b'), .already_applied = false,
        .current = try snapshot("src/main.zig", 'b', "const repaired = true;\n"),
    } });
    try emitter.emit("result_replace_denied", "result", "replace", praxis.ReplaceOutcome, .{ .denied = .{ .path = try text(praxis.Path, "src/main.zig"), .reason = try text(praxis.ReasonText, "not writable") } });
    try emitter.emit("result_replace_conflict", "result", "replace", praxis.ReplaceOutcome, .{ .conflict = .{ .path = try text(praxis.Path, "src/main.zig"), .expected_sha256 = try digest('a'), .actual_sha256 = try digest('c') } });

    try emitDecisionTurns(&emitter);
    try emitter.writer.writeAll("\n  ]\n}\n");
    try emitter.writer.flush();
}
