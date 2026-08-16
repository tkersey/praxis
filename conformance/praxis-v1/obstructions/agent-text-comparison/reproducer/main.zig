const agent = @import("agent");
const boundary = @import("boundary");

const Path = boundary.Text(256);
const ReplaceRequest = struct { path: Path };
const ReplaceFile = boundary.effect.site(1, "repo.replace.approved.v2", ReplaceRequest, void);
const Failure = enum {
    budget_exhausted,
    arithmetic_overflow,
    invalid_index,
    invalid_variant,
    capacity_exceeded,
    authored_abort,
};
const Action = union(enum) { replace_file: ReplaceRequest, final: void };
const Observation = union(enum) { replace_file: void };
const MemoryState = struct { latest_path: Path };

const Definition = agent.define(.{
    .name = "praxis-agent-text-comparison-reproducer",
    .version = "1.0.0",
    .instructions = "Replace only the path held in Memory.",
    .Goal = void,
    .Action = Action,
    .Observation = Observation,
    .Result = void,
    .Failure = Failure,
    .decision = .{
        .interface = "model.decide.v1",
        .maximum_request_bytes = 4096,
        .maximum_result_bytes = 1024,
    },
    .actions = .{
        agent.action.effect(.replace_file, .replace_file, ReplaceFile, .{
            .name = "replace_file",
            .description = "Replace the exact admitted path.",
            .class = .human,
        }),
        agent.action.final(.final, .{ .name = "final", .description = "Finish." }),
    },
    .budget = .{
        .maximum_turns = 2,
        .maximum_decisions = 2,
        .maximum_effect_actions = 1,
        .maximum_child_actions = 0,
    },
});

const WorkingSet = struct {
    pub const semantic_identity = "agent.epistemics.praxis-text-comparison-reproducer.v1";
    pub fn validate(comptime _: type, comptime _: void) void {}
    pub fn Memory(comptime _: type, comptime _: void) type {
        return MemoryState;
    }
    const MemoryType = MemoryState;
    pub fn DecisionView(comptime _: type, comptime _: void) type {
        return MemoryType;
    }
    pub fn StateSchemaTypes(comptime _: type, comptime _: void) @TypeOf(.{ MemoryType, Path }) {
        return .{ MemoryType, Path };
    }
    pub fn initialMemory(comptime _: type, comptime _: void) MemoryType {
        return .{ .latest_path = Path.empty() };
    }
    pub fn emitObserve(comptime _: type, comptime _: void, flow: anytype, memory: anytype, _: anytype, comptime _: anytype) agent.Value(MemoryType) {
        return flow.copy(memory);
    }
    pub fn emitProject(comptime _: type, comptime _: void, flow: anytype, memory: anytype) agent.Value(MemoryType) {
        return flow.copy(memory);
    }
    pub fn emitActionAllowed(comptime _: type, comptime _: void, flow: anytype, memory: anytype, action: anytype, comptime _: anytype) agent.Value(bool) {
        const current = flow.productExtract(0, memory);
        const requested = flow.productExtract(0, flow.sumExtract(0, action));
        const ordering = flow.textCompare(current, requested);
        return flow.compareEqZero(ordering);
    }
    pub fn emitFinalAllowed(comptime _: type, comptime _: void, flow: anytype, _: anytype, _: anytype, comptime context: anytype) agent.Value(bool) {
        return flow.constant(bool, context.false_index);
    }
};

const Epistemics = agent.epistemics.custom(.{
    .semantic_identity = "agent.epistemics.praxis-text-comparison-reproducer.v1",
    .config = {},
    .implementation = WorkingSet,
});

comptime {
    _ = agent.compile(Definition, agent.strategy.react(.{}), Epistemics, .{ .machine = .{} });
}
