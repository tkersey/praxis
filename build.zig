const std = @import("std");
const builtin = @import("builtin");

pub fn build(b: *std.Build) void {
    const required_zig = std.SemanticVersion.parse("0.16.0") catch unreachable;
    if (!std.meta.eql(builtin.zig_version, required_zig)) {
        std.debug.panic(
            "Praxis v1 requires exact Zig 0.16.0, found {f}",
            .{builtin.zig_version},
        );
    }

    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const agent_dependency = b.dependency("agent", .{
        .target = target,
        .optimize = optimize,
    });
    const witness = b.createModule(.{
        .root_source_file = b.path("src/obstruction_test.zig"),
        .target = target,
        .optimize = optimize,
    });
    witness.addImport("agent", agent_dependency.module("agent"));
    witness.addImport("boundary", agent_dependency.module("boundary"));
    const release_sources = b.addOptions();
    release_sources.addOption(
        []const u8,
        "reference_stack_lock",
        @embedFile("conformance/praxis-v1/reference-stack.lock.json"),
    );
    release_sources.addOption([]const u8, "package_manifest", @embedFile("build.zig.zon"));
    release_sources.addOption(
        []const u8,
        "obstruction_result",
        @embedFile("conformance/praxis-v1/obstructions/agent-pre-effect-admission/result.txt"),
    );
    witness.addOptions("release_sources", release_sources);

    const tests = b.addTest(.{ .root_module = witness });
    const check = b.step("check", "Run the Praxis v1 Agent obstruction witness");
    check.dependOn(&b.addRunArtifact(tests).step);
}
