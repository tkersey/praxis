const std = @import("std");
const praxis = @import("praxis_definition");

pub fn main(init: std.process.Init) !void {
    var buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writer(init.io, &buffer);
    const out = &writer.interface;
    try out.print("machine_frame_bytes={d}\n", .{@sizeOf(praxis.Compiled.Machine.FrameType)});
    try out.print("machine_state_bytes={d}\n", .{@sizeOf(praxis.Compiled.Machine.State)});
    try out.print("machine_maximum_segment_value_bytes={d}\n", .{praxis.Compiled.Program.maximum_segment_value_bytes});
    try out.print("machine_reachable_value_catalog_bytes={d}\n", .{praxis.Compiled.Program.reachable_value_catalog_bytes});
    try out.print("memory_bytes={d}\n", .{@sizeOf(praxis.Memory)});
    try out.print("decision_view_bytes={d}\n", .{@sizeOf(praxis.DecisionView)});
    try out.flush();
}
