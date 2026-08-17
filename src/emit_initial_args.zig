const std = @import("std");
const boundary = @import("boundary");
const praxis = @import("praxis_definition");

const Parsed = struct {
    task_file: []const u8,
    repository: []const u8,
    base_revision: []const u8,
};

fn parseArgs(raw: []const []const u8) !Parsed {
    var parsed: struct {
        task_file: ?[]const u8 = null,
        repository: ?[]const u8 = null,
        base_revision: ?[]const u8 = null,
    } = .{};
    var index: usize = 0;
    while (index < raw.len) : (index += 2) {
        if (index + 1 >= raw.len) return error.InvalidArguments;
        const name = raw[index];
        const value = raw[index + 1];
        if (std.mem.eql(u8, name, "--task-file")) {
            if (parsed.task_file != null) return error.InvalidArguments;
            parsed.task_file = value;
        } else if (std.mem.eql(u8, name, "--repository")) {
            if (parsed.repository != null) return error.InvalidArguments;
            parsed.repository = value;
        } else if (std.mem.eql(u8, name, "--base-revision")) {
            if (parsed.base_revision != null) return error.InvalidArguments;
            parsed.base_revision = value;
        } else return error.InvalidArguments;
    }
    return .{
        .task_file = parsed.task_file orelse return error.InvalidArguments,
        .repository = parsed.repository orelse return error.InvalidArguments,
        .base_revision = parsed.base_revision orelse return error.InvalidArguments,
    };
}

fn validRevision(value: []const u8) bool {
    if (value.len != 40) return false;
    for (value) |byte| switch (byte) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

fn makeGoal(task: []const u8, repository: []const u8, revision: []const u8) !praxis.Goal {
    if (!std.unicode.utf8ValidateSlice(task) or
        !std.unicode.utf8ValidateSlice(repository) or
        !std.unicode.utf8ValidateSlice(revision) or
        !validRevision(revision)) return error.InvalidArguments;
    return .{
        .task = praxis.TaskText.fromSlice(task) catch return error.InvalidArguments,
        .repository = praxis.RepositoryLabel.fromSlice(repository) catch return error.InvalidArguments,
        .base_revision = praxis.RevisionText.fromSlice(revision) catch return error.InvalidArguments,
    };
}

pub fn main(init: std.process.Init) !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var iterator = std.process.Args.Iterator.init(init.minimal.args);
    _ = iterator.next();
    var raw: [6][]const u8 = undefined;
    var count: usize = 0;
    while (iterator.next()) |arg| {
        if (count == raw.len) return error.InvalidArguments;
        raw[count] = arg;
        count += 1;
    }
    const parsed = try parseArgs(raw[0..count]);
    const task = try std.Io.Dir.cwd().readFileAlloc(
        init.io,
        parsed.task_file,
        allocator,
        .limited(8 * 1024 + 1),
    );
    const goal = try makeGoal(task, parsed.repository, parsed.base_revision);
    const required = try boundary.schema.encodedSize(praxis.Goal, goal);
    if (required > 16 * 1024) return error.InvalidArguments;
    const encoded = try allocator.alloc(u8, required);
    _ = try boundary.schema.encode(praxis.Goal, goal, encoded);
    var output_buffer: [16 * 1024]u8 = undefined;
    var output = std.Io.File.stdout().writer(init.io, &output_buffer);
    try output.interface.writeAll(encoded);
    try output.interface.flush();
}

test "argument parser accepts each required flag exactly once" {
    const parsed = try parseArgs(&.{
        "--repository",
        "tkersey/agent",
        "--task-file",
        "task.md",
        "--base-revision",
        "0123456789abcdef0123456789abcdef01234567",
    });
    try std.testing.expectEqualStrings("task.md", parsed.task_file);
    try std.testing.expectEqualStrings("tkersey/agent", parsed.repository);
}

test "argument parser rejects missing duplicate unknown and extra arguments" {
    try std.testing.expectError(error.InvalidArguments, parseArgs(&.{ "--task-file", "task.md" }));
    try std.testing.expectError(error.InvalidArguments, parseArgs(&.{ "--unknown", "value" }));
    try std.testing.expectError(error.InvalidArguments, parseArgs(&.{
        "--task-file",
        "one",
        "--task-file",
        "two",
        "--repository",
        "repo",
        "--base-revision",
        "0123456789abcdef0123456789abcdef01234567",
    }));
    try std.testing.expectError(error.InvalidArguments, parseArgs(&.{"--task-file"}));
}

test "goal admission enforces UTF-8 bounds and lowercase forty-hex revision" {
    const valid = "0123456789abcdef0123456789abcdef01234567";
    _ = try makeGoal("repair", "tkersey/agent", valid);
    try std.testing.expectError(error.InvalidArguments, makeGoal("repair", "tkersey/agent", "abc"));
    try std.testing.expectError(
        error.InvalidArguments,
        makeGoal("repair", "tkersey/agent", "0123456789abcdef0123456789abcdef0123456A"),
    );
    try std.testing.expectError(error.InvalidArguments, makeGoal("\xff", "tkersey/agent", valid));
    try std.testing.expectError(error.InvalidArguments, makeGoal("repair", "\xff", valid));
    const oversized = [_]u8{'a'} ** (8 * 1024 + 1);
    try std.testing.expectError(error.InvalidArguments, makeGoal(&oversized, "tkersey/agent", valid));
}
