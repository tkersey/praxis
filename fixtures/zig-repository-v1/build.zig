const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const range = b.createModule(.{
        .root_source_file = b.path("src/range.zig"),
        .target = target,
        .optimize = optimize,
    });
    const tests_module = b.createModule(.{
        .root_source_file = b.path("test/range_test.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "range", .module = range }},
    });
    const tests = b.addTest(.{ .root_module = tests_module });
    const check = b.step("check", "Run the complete fixture check");
    check.dependOn(&b.addRunArtifact(tests).step);
}
