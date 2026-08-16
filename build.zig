const std = @import("std");

pub fn build(b: *std.Build) void {
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

    const tests = b.addTest(.{ .root_module = witness });
    const check = b.step("check", "Run the Praxis v1 Agent obstruction witness");
    check.dependOn(&b.addRunArtifact(tests).step);
}
