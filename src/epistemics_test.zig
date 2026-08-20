const std = @import("std");
const praxis = @import("definition.zig");

const Machine = praxis.Compiled.Machine;

noinline fn nextRequest(state: Machine.State) !Machine.Request {
    var fuel: u64 = 8_000_000;
    return switch (try Machine.step(state, &fuel)) {
        .request => |request| request,
        .failed => return error.MachineFailedBeforeRequest,
        .yielded => return error.MachineYieldedBeforeRequest,
        .done => return error.MachineCompletedBeforeRequest,
    };
}

noinline fn resumeRequest(state: *Machine.State, request: Machine.Request, value: anytype) !void {
    const prepared = try Machine.prepareResume(state.*, request);
    defer Machine.deinitPreparedResume(prepared);
    try Machine.@"resume"(prepared, value);
}

fn goal() !praxis.Goal {
    return .{
        .task = try praxis.TaskText.fromSlice("Repair the admitted Zig fixture."),
        .repository = try praxis.RepositoryLabel.fromSlice("tkersey/fixture"),
        .base_revision = try praxis.RevisionText.fromSlice("0123456789abcdef0123456789abcdef01234567"),
    };
}

fn newState() !Machine.State {
    return Machine.initialState(std.testing.allocator, try goal());
}

fn decisionView(request: Machine.Request) !praxis.DecisionView {
    return switch (request.value) {
        .s0 => |turn| turn.context,
        else => error.ExpectedDecisionRequest,
    };
}

noinline fn driveEffect(state: *Machine.State, action: praxis.Action, result: anytype) !void {
    const decision = try nextRequest(state.*);
    _ = try decisionView(decision);
    try resumeRequest(state, decision, action);
    const effect = try nextRequest(state.*);
    try resumeRequest(state, effect, result);
}

noinline fn expectRejectedAction(state: *Machine.State, action: praxis.Action, expected: praxis.Failure) !void {
    const decision = try nextRequest(state.*);
    try resumeRequest(state, decision, action);
    var fuel: u64 = 8_000_000;
    switch (try Machine.step(state.*, &fuel)) {
        .failed => |failure| switch (failure) {
            .authored => |authored| try std.testing.expectEqual(expected, authored),
            else => return error.ExpectedAuthoredFailure,
        },
        .request => return error.ForbiddenEffectEmitted,
        else => return error.ExpectedRejectedAction,
    }
}

fn indexedPath(index: usize) !praxis.Path {
    var buffer: [32]u8 = undefined;
    const value = try std.fmt.bufPrint(&buffer, "src/file-{d}.zig", .{index});
    return praxis.Path.fromSlice(value);
}

fn digest(index: usize) !praxis.DigestHex {
    const digit: u8 = "0123456789abcdef"[index % 16];
    var bytes = [_]u8{digit} ** 64;
    return praxis.DigestHex.fromSlice(&bytes);
}

fn snapshot(path: praxis.Path, digest_index: usize, contents: []const u8) !praxis.DocumentSnapshot {
    return .{
        .path = path,
        .sha256 = try digest(digest_index),
        .contents = try praxis.FileText.fromSlice(contents),
    };
}

fn readAction(path: praxis.Path) praxis.Action {
    return .{ .read_file = .{ .path = path } };
}

fn testResult(passed: bool) !praxis.TestResult {
    return .{
        .exit_code = if (passed) 0 else 1,
        .passed = passed,
        .output = try praxis.TestOutput.fromSlice(if (passed) "all checks passed" else "check failed"),
        .truncated = false,
    };
}

fn testAction() praxis.Action {
    return .{ .run_tests = .{ .suite = .full } };
}

fn replaceAction(path: praxis.Path, expected_digest_index: usize) !praxis.Action {
    return .{ .replace_file = .{
        .path = path,
        .expected_sha256 = try digest(expected_digest_index),
        .replacement = try praxis.FileText.fromSlice("const repaired = true;\n"),
        .rationale = try praxis.SummaryText.fromSlice("Apply the bounded repair."),
    } };
}

fn appliedOutcome(path: praxis.Path, old_index: usize, new_index: usize, already_applied: bool) !praxis.ReplaceOutcome {
    return .{ .applied = .{
        .path = path,
        .old_sha256 = try digest(old_index),
        .new_sha256 = try digest(new_index),
        .already_applied = already_applied,
        .current = try snapshot(path, new_index, "const repaired = true;\n"),
    } };
}

fn listing(path_text: []const u8, writable: bool) !praxis.ListResult {
    var entries = praxis.ListedFiles.empty();
    try entries.push(.{
        .path = try praxis.Path.fromSlice(path_text),
        .size_bytes = 16,
        .writable = writable,
    });
    return .{ .entries = entries, .truncated = false };
}

fn searchResult(path_text: []const u8, line: u32) !praxis.SearchResult {
    var hits = praxis.SearchHits.empty();
    try hits.push(.{
        .path = try praxis.Path.fromSlice(path_text),
        .line = line,
        .excerpt = try praxis.ExcerptText.fromSlice("literal match"),
    });
    return .{ .hits = hits, .truncated = false };
}

fn finalResult(path: praxis.Path, mutation_count: u32) !praxis.FinalResult {
    var changed = praxis.ChangedFiles.empty();
    try changed.push(path);
    return .{
        .summary = try praxis.SummaryText.fromSlice("Repaired and verified the repository."),
        .changed_files = changed,
        .tests_passed = true,
        .mutation_count = mutation_count,
    };
}

fn applyFirstMutation(state: *Machine.State, path: praxis.Path) !void {
    try driveEffect(state, readAction(path), try snapshot(path, 0, "const repaired = false;\n"));
    try driveEffect(state, testAction(), try testResult(false));
    try driveEffect(state, try replaceAction(path, 0), try appliedOutcome(path, 0, 1, false));
}

test "initial projection" {
    const memory = praxis.Epistemics.initialMemory(praxis.Definition);
    try std.testing.expect(memory.listing == null);
    try std.testing.expectEqual(@as(u32, 0), try memory.documents.len());
    try std.testing.expect(memory.latest_search == null);
    try std.testing.expect(memory.latest_test == null);
    try std.testing.expect(memory.latest_replace == null);
    try std.testing.expectEqual(@as(u32, 0), try memory.mutations.len());
    try std.testing.expect(!memory.baseline_test_observed);
    try std.testing.expect(!memory.latest_test_passed);
    try std.testing.expectEqual(@as(u32, 0), memory.mutation_count);
    try std.testing.expectEqual(@as(u32, 0), memory.last_test_mutation_count);
    try std.testing.expectEqual(@as(u32, 0), memory.test_count);
}

test "listing and search replacement" {
    var state = try newState();
    defer Machine.deinitState(state);
    try driveEffect(&state, .{ .list_repository = {} }, try listing("src/old.zig", false));
    try driveEffect(&state, .{ .list_repository = {} }, try listing("src/new.zig", true));
    try driveEffect(&state, .{ .search_text = .{
        .query = try praxis.QueryText.fromSlice("old"),
        .path_prefix = try praxis.Path.fromSlice("src"),
    } }, try searchResult("src/old.zig", 1));
    try driveEffect(&state, .{ .search_text = .{
        .query = try praxis.QueryText.fromSlice("new"),
        .path_prefix = try praxis.Path.fromSlice("src"),
    } }, try searchResult("src/new.zig", 7));
    const view = try decisionView(try nextRequest(state));
    const retained_listing = view.listing orelse return error.ExpectedListing;
    const entry = (try retained_listing.entries.get(0)) orelse return error.ExpectedEntry;
    try std.testing.expectEqualStrings("src/new.zig", try entry.path.slice());
    const retained_search = view.latest_search orelse return error.ExpectedSearch;
    const hit = (try retained_search.hits.get(0)) orelse return error.ExpectedSearchHit;
    try std.testing.expectEqual(@as(u32, 7), hit.line);
}

test "document upsert and reread" {
    var state = try newState();
    defer Machine.deinitState(state);
    const path = try indexedPath(0);
    try driveEffect(&state, readAction(path), try snapshot(path, 0, "old"));
    try driveEffect(&state, readAction(path), try snapshot(path, 1, "new"));
    const view = try decisionView(try nextRequest(state));
    try std.testing.expectEqual(@as(u32, 1), try view.documents.len());
    const document = (try view.documents.get(0)) orelse return error.ExpectedDocument;
    try std.testing.expectEqualStrings("new", try document.contents.slice());
    const expected = try digest(1);
    try std.testing.expect(document.sha256.eql(&expected));
}

test "eleventh document overflows before committed memory mutation" {
    var state = try newState();
    defer Machine.deinitState(state);
    for (0..praxis.maximum_documents) |index| {
        const path = try indexedPath(index);
        try driveEffect(&state, readAction(path), try snapshot(path, index, "document"));
    }
    const overflow_path = try indexedPath(praxis.maximum_documents);
    const decision = try nextRequest(state);
    try resumeRequest(&state, decision, readAction(overflow_path));
    const effect = try nextRequest(state);
    try resumeRequest(&state, effect, try snapshot(overflow_path, 11, "overflow"));
    var fuel: u64 = 8_000_000;
    switch (try Machine.step(state, &fuel)) {
        .failed => |failure| switch (failure) {
            .authored => |authored| try std.testing.expectEqual(praxis.Failure.capacity_exceeded, authored),
            else => return error.ExpectedCapacityFailure,
        },
        else => return error.ExpectedCapacityFailure,
    }
}

test "baseline passing and failing checks update exact evidence" {
    var passing = try newState();
    defer Machine.deinitState(passing);
    try driveEffect(&passing, testAction(), try testResult(true));
    const passing_view = try decisionView(try nextRequest(passing));
    try std.testing.expect(passing_view.evidence.baseline_test_observed);
    try std.testing.expect(passing_view.evidence.latest_test_passed);
    try std.testing.expectEqual(@as(u32, 1), passing_view.evidence.test_count);

    var failing = try newState();
    defer Machine.deinitState(failing);
    try driveEffect(&failing, testAction(), try testResult(false));
    const failing_view = try decisionView(try nextRequest(failing));
    try std.testing.expect(failing_view.evidence.baseline_test_observed);
    try std.testing.expect(!failing_view.evidence.latest_test_passed);
    try std.testing.expectEqual(@as(u32, 0), failing_view.evidence.last_test_mutation_count);
}

test "first mutation after baseline check updates documents and invalidates tests" {
    var state = try newState();
    defer Machine.deinitState(state);
    const path = try indexedPath(0);
    try applyFirstMutation(&state, path);
    const view = try decisionView(try nextRequest(state));
    try std.testing.expectEqual(@as(u32, 1), view.evidence.mutation_count);
    try std.testing.expect(!view.evidence.latest_test_passed);
    try std.testing.expectEqual(@as(u32, 1), try view.mutations.len());
    const document = (try view.documents.get(0)) orelse return error.ExpectedDocument;
    const expected = try digest(1);
    try std.testing.expect(document.sha256.eql(&expected));
}

test "mutation before baseline check is rejected before effect emission" {
    var state = try newState();
    defer Machine.deinitState(state);
    const path = try indexedPath(0);
    try driveEffect(&state, readAction(path), try snapshot(path, 0, "old"));
    try expectRejectedAction(&state, try replaceAction(path, 0), .invalid_variant);
}

test "second mutation without an intervening check is rejected" {
    var state = try newState();
    defer Machine.deinitState(state);
    const path = try indexedPath(0);
    try applyFirstMutation(&state, path);
    try expectRejectedAction(&state, try replaceAction(path, 1), .invalid_variant);
}

test "same path revision after failed check and reread is admitted" {
    var state = try newState();
    defer Machine.deinitState(state);
    const path = try indexedPath(0);
    try applyFirstMutation(&state, path);
    try driveEffect(&state, testAction(), try testResult(false));
    try driveEffect(&state, readAction(path), try snapshot(path, 1, "first repair"));
    try driveEffect(&state, try replaceAction(path, 1), try appliedOutcome(path, 1, 2, false));
    const view = try decisionView(try nextRequest(state));
    try std.testing.expectEqual(@as(u32, 2), view.evidence.mutation_count);
    try std.testing.expectEqual(@as(u32, 2), try view.mutations.len());
}

test "retained duplicate applied result is byte-identical and counted once" {
    var state = try newState();
    defer Machine.deinitState(state);
    const path = try indexedPath(0);
    try driveEffect(&state, readAction(path), try snapshot(path, 0, "old"));
    try driveEffect(&state, testAction(), try testResult(false));
    const decision = try nextRequest(state);
    try resumeRequest(&state, decision, try replaceAction(path, 0));
    const effect = try nextRequest(state);
    var retry = try Machine.cloneState(std.testing.allocator, state);
    defer Machine.deinitState(retry);
    const outcome = try appliedOutcome(path, 0, 1, false);
    try resumeRequest(&state, effect, outcome);
    try resumeRequest(&retry, effect, outcome);
    const first = try Machine.encodeState(std.testing.allocator, state);
    defer std.testing.allocator.free(first);
    const second = try Machine.encodeState(std.testing.allocator, retry);
    defer std.testing.allocator.free(second);
    try std.testing.expectEqualSlices(u8, first, second);
    const view = try decisionView(try nextRequest(state));
    try std.testing.expectEqual(@as(u32, 1), view.evidence.mutation_count);
}

test "denied and conflicting replacements do not mutate memory" {
    inline for (.{ false, true }) |conflict| {
        var state = try newState();
        defer Machine.deinitState(state);
        const path = try indexedPath(0);
        try driveEffect(&state, readAction(path), try snapshot(path, 0, "old"));
        try driveEffect(&state, testAction(), try testResult(true));
        const outcome: praxis.ReplaceOutcome = if (conflict)
            .{ .conflict = .{ .path = path, .expected_sha256 = try digest(0), .actual_sha256 = try digest(1) } }
        else
            .{ .denied = .{ .path = path, .reason = try praxis.ReasonText.fromSlice("receiver denied proposal") } };
        try driveEffect(&state, try replaceAction(path, 0), outcome);
        const view = try decisionView(try nextRequest(state));
        try std.testing.expectEqual(@as(u32, 0), view.evidence.mutation_count);
        try std.testing.expectEqual(@as(u32, 0), try view.mutations.len());
        try std.testing.expect(view.evidence.latest_test_passed);
    }
}

test "six operation limit rejects the seventh replacement before effect emission" {
    var state = try newState();
    defer Machine.deinitState(state);
    const path = try indexedPath(0);
    try driveEffect(&state, readAction(path), try snapshot(path, 0, "initial"));
    try driveEffect(&state, testAction(), try testResult(false));
    for (0..praxis.maximum_mutation_operations) |index| {
        try driveEffect(&state, try replaceAction(path, index), try appliedOutcome(path, index, index + 1, false));
        if (index + 1 < praxis.maximum_mutation_operations) {
            try driveEffect(&state, testAction(), try testResult(false));
            try driveEffect(&state, readAction(path), try snapshot(path, index + 1, "revision"));
        }
    }
    try driveEffect(&state, testAction(), try testResult(true));
    try driveEffect(&state, readAction(path), try snapshot(path, 6, "sixth revision"));
    try expectRejectedAction(&state, try replaceAction(path, 6), .invalid_variant);
}

test "four distinct path limit rejects the fifth path before effect emission" {
    var state = try newState();
    defer Machine.deinitState(state);
    try driveEffect(&state, testAction(), try testResult(false));
    for (0..praxis.maximum_changed_files) |index| {
        const path = try indexedPath(index);
        try driveEffect(&state, readAction(path), try snapshot(path, 0, "initial"));
        try driveEffect(&state, try replaceAction(path, 0), try appliedOutcome(path, 0, index + 1, false));
        try driveEffect(&state, testAction(), try testResult(false));
    }
    const fifth = try indexedPath(praxis.maximum_changed_files);
    try driveEffect(&state, readAction(fifth), try snapshot(fifth, 0, "fifth"));
    try expectRejectedAction(&state, try replaceAction(fifth, 0), .invalid_variant);
}

test "final before mutation is rejected" {
    var state = try newState();
    defer Machine.deinitState(state);
    try expectRejectedAction(&state, .{ .final = try finalResult(try indexedPath(0), 0) }, .invalid_variant);
}

test "final with stale or failing test is rejected" {
    inline for (.{ false, true }) |run_failing_test| {
        var state = try newState();
        defer Machine.deinitState(state);
        const path = try indexedPath(0);
        try applyFirstMutation(&state, path);
        if (run_failing_test) try driveEffect(&state, testAction(), try testResult(false));
        try expectRejectedAction(&state, .{ .final = try finalResult(path, 1) }, .invalid_variant);
    }
}

test "final with fabricated changed paths or count is rejected" {
    inline for (.{ false, true }) |wrong_count| {
        var state = try newState();
        defer Machine.deinitState(state);
        const path = try indexedPath(0);
        try applyFirstMutation(&state, path);
        try driveEffect(&state, testAction(), try testResult(true));
        const reported_path = if (wrong_count) path else try indexedPath(9);
        const reported_count: u32 = if (wrong_count) 2 else 1;
        try expectRejectedAction(&state, .{ .final = try finalResult(reported_path, reported_count) }, .invalid_variant);
    }
}

test "valid final follows a fresh passing check and exact Memory paths" {
    var state = try newState();
    defer Machine.deinitState(state);
    const path = try indexedPath(0);
    try applyFirstMutation(&state, path);
    try driveEffect(&state, testAction(), try testResult(true));
    const decision = try nextRequest(state);
    const view = try decisionView(decision);
    try std.testing.expectEqual(@as(u32, 1), view.evidence.mutation_count);
    try std.testing.expect(view.evidence.latest_test_passed);
    try resumeRequest(&state, decision, praxis.Action{ .final = try finalResult(path, 1) });
    var fuel: u64 = 8_000_000;
    const done = switch (try Machine.step(state, &fuel)) {
        .done => |result| result,
        else => return error.ExpectedFinalResult,
    };
    defer done.deinit();
    try std.testing.expect(done.value().tests_passed);
    try std.testing.expectEqual(@as(u32, 1), done.value().mutation_count);
}

test "compiled repository steward preserves semantic identity and machine envelope" {
    try std.testing.expectEqual(@as(u32, 2), Machine.abi_version);
    try std.testing.expectEqualSlices(u8, "ABL_RNF2", &Machine.Manifest.state_image_magic);
    try std.testing.expectEqualStrings(
        "agent.epistemics.praxis-zig-working-set.v1",
        praxis.Epistemics.semantic_identity,
    );
    try std.testing.expect(praxis.Compiled.Epistemics == praxis.Epistemics);
}

test "model-visible mutation budget follows the Machine capacity" {
    const expected = std.fmt.comptimePrint(
        "Use at most {d} applied replacements across at most four distinct files.",
        .{praxis.maximum_mutation_operations},
    );
    try std.testing.expect(std.mem.indexOf(u8, praxis.instructions, expected) != null);
    try std.testing.expect(std.mem.indexOf(u8, praxis.instructions, "Use at most six applied replacements") == null);
}
