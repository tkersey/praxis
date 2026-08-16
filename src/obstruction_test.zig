const std = @import("std");
const agent = @import("agent");
const boundary = @import("boundary");

const TestRequest = struct { suite: u8 };
const TestResult = struct { passed: bool };
const ReplaceRequest = struct { marker: u8 };
const ReplaceOutcome = enum { applied, denied, conflict };

const RunTests = boundary.effect.site(1, "repo.test.v2", TestRequest, TestResult);
const ReplaceFile = boundary.effect.site(
    2,
    "repo.replace.approved.v2",
    ReplaceRequest,
    ReplaceOutcome,
);

const EvidenceMemory = struct {
    baseline_test_observed: bool,
};

const Action = union(enum) {
    run_tests: TestRequest,
    replace_file: ReplaceRequest,
    final: u32,
    abort: Failure,
};

const Observation = union(enum) {
    run_tests: TestResult,
    replace_file: ReplaceOutcome,
};

const Failure = enum {
    budget_exhausted,
    arithmetic_overflow,
    invalid_index,
    invalid_variant,
    capacity_exceeded,
    authored_abort,
};

const Definition = agent.define(.{
    .name = "praxis-pre-effect-admission-obstruction",
    .version = "1.0.0",
    .instructions = "Run the full test before any replacement.",
    .Goal = void,
    .Action = Action,
    .Observation = Observation,
    .Result = u32,
    .Failure = Failure,
    .decision = .{
        .interface = "model.decide.v1",
        .maximum_request_bytes = 4096,
        .maximum_result_bytes = 1024,
    },
    .actions = .{
        agent.action.effect(.run_tests, .run_tests, RunTests, .{
            .name = "run_tests",
            .description = "Run the fixed full test.",
            .class = .tool,
        }),
        agent.action.effect(.replace_file, .replace_file, ReplaceFile, .{
            .name = "replace_file",
            .description = "Replace one admitted file.",
            .class = .human,
        }),
        agent.action.final(.final, .{ .name = "final", .description = "Finish." }),
        agent.action.fail(.abort, .{ .name = "abort", .description = "Abort." }),
    },
    .budget = .{
        .maximum_turns = 4,
        .maximum_decisions = 4,
        .maximum_effect_actions = 3,
        .maximum_child_actions = 0,
    },
});

const WorkingSet = struct {
    pub const semantic_identity = "agent.epistemics.praxis-obstruction.v1";

    pub fn validate(comptime _: type, comptime _: anytype) void {}

    pub fn Memory(comptime _: type, comptime _: anytype) type {
        return EvidenceMemory;
    }

    pub fn DecisionView(comptime _: type, comptime _: anytype) type {
        return EvidenceMemory;
    }

    pub fn StateSchemaTypes(comptime _: type, comptime _: anytype) @TypeOf(.{EvidenceMemory}) {
        return .{EvidenceMemory};
    }

    pub fn initialMemory(comptime _: type, comptime _: anytype) EvidenceMemory {
        return .{ .baseline_test_observed = false };
    }

    pub fn emitObserve(
        comptime _: type,
        comptime _: anytype,
        flow: anytype,
        memory: anytype,
        _: anytype,
        comptime _: anytype,
    ) agent.Value(EvidenceMemory) {
        return flow.copy(memory);
    }

    pub fn emitObserveKnown(
        comptime _: type,
        comptime _: anytype,
        flow: anytype,
        memory: anytype,
        comptime observation_index: u16,
        observation: anytype,
        comptime context: anytype,
    ) agent.Value(EvidenceMemory) {
        _ = flow.sumExtract(observation_index, observation);
        return observePayload(flow, memory, observation_index, context);
    }

    pub fn emitObservePayload(
        comptime _: type,
        comptime _: anytype,
        flow: anytype,
        memory: anytype,
        comptime observation_index: u16,
        _: anytype,
        comptime context: anytype,
    ) agent.Value(EvidenceMemory) {
        return observePayload(flow, memory, observation_index, context);
    }

    fn observePayload(
        flow: anytype,
        memory: anytype,
        comptime observation_index: u16,
        comptime context: anytype,
    ) agent.Value(EvidenceMemory) {
        return switch (observation_index) {
            0 => flow.productReplace(
                0,
                memory,
                flow.constant(bool, context.true_index),
            ),
            1 => flow.copy(memory),
            else => unreachable,
        };
    }

    pub fn emitProject(
        comptime _: type,
        comptime _: anytype,
        flow: anytype,
        memory: anytype,
    ) agent.Value(EvidenceMemory) {
        return flow.copy(memory);
    }

    pub fn emitFinalAllowed(
        comptime _: type,
        comptime _: anytype,
        flow: anytype,
        _: anytype,
        _: anytype,
        comptime context: anytype,
    ) agent.Value(bool) {
        return flow.constant(bool, context.false_index);
    }
};

const Epistemics = agent.epistemics.custom(.{
    .semantic_identity = "agent.epistemics.praxis-zig-working-set.v1",
    .config = .{},
    .implementation = WorkingSet,
});

const Compiled = agent.compile(
    Definition,
    agent.strategy.react(.{}),
    Epistemics,
    .{
        .machine = .{
            .maximum_frames = 16,
            .maximum_state_bytes = 64 * 1024,
            .maximum_machine_fuel = 4096,
        },
    },
);

const Machine = Compiled.Machine;

fn resumeRequest(state: *Machine.State, request: Machine.Request, value: anytype) !void {
    const prepared = try Machine.prepareResume(state.*, request);
    defer Machine.deinitPreparedResume(prepared);
    try Machine.@"resume"(prepared, value);
}

test "Agent v2.2.0 reaches replacement before the baseline test invariant" {
    try std.testing.expectEqual(@as(u32, 2), Machine.abi_version);
    try std.testing.expectEqualSlices(u8, "ABL_RNF2", &Machine.Manifest.state_image_magic);
    try std.testing.expectEqualStrings(
        "repo.replace.approved.v2",
        Compiled.ActionSites[2].semantic_identity,
    );

    var state = try Machine.initialState(std.testing.allocator, @as(void, {}));
    defer Machine.deinitState(state);
    var fuel: u64 = 4096;

    const decision = switch (try Machine.step(state, &fuel)) {
        .request => |request| request,
        else => return error.UnexpectedMachineStep,
    };
    switch (decision.value) {
        .s0 => |turn| try std.testing.expect(!turn.context.baseline_test_observed),
        else => return error.ExpectedDecisionRequest,
    }

    try resumeRequest(&state, decision, Action{ .replace_file = .{ .marker = 7 } });

    const effect = switch (try Machine.step(state, &fuel)) {
        .request => |request| request,
        else => return error.UnexpectedMachineStep,
    };
    switch (effect.value) {
        .s2 => |payload| try std.testing.expectEqual(@as(u8, 7), payload.marker),
        else => return error.ExpectedReplacementRequest,
    }
}

test "the custom Memory does record an observed baseline test" {
    var state = try Machine.initialState(std.testing.allocator, @as(void, {}));
    defer Machine.deinitState(state);
    var fuel: u64 = 4096;

    const decision = switch (try Machine.step(state, &fuel)) {
        .request => |request| request,
        else => return error.UnexpectedMachineStep,
    };
    try resumeRequest(&state, decision, Action{ .run_tests = .{ .suite = 0 } });

    const effect = switch (try Machine.step(state, &fuel)) {
        .request => |request| request,
        else => return error.UnexpectedMachineStep,
    };
    try resumeRequest(&state, effect, TestResult{ .passed = false });

    const next_decision = switch (try Machine.step(state, &fuel)) {
        .request => |request| request,
        else => return error.UnexpectedMachineStep,
    };
    switch (next_decision.value) {
        .s0 => |turn| try std.testing.expect(turn.context.baseline_test_observed),
        else => return error.ExpectedDecisionRequest,
    }
}
