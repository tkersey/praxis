const std = @import("std");
const agent = @import("agent");
const boundary = @import("boundary");
const release_sources = @import("release_sources");

const TestRequest = struct { suite: u8 };
const TestResult = struct { passed: bool };

// These are the application-owned repository-steward contracts fixed by the
// Praxis v1 specification. Agent's adequacy/router-policy-v1 types belong to a
// separate released fixture; its slot-based schemas are not global owners of
// these labels and are deliberately not imported here.
const Path = boundary.Text(256);
const FileText = boundary.Text(16 * 1024);
const SummaryText = boundary.Text(4 * 1024);
const ReasonText = boundary.Text(512);
const DigestHex = boundary.Text(64);

const DocumentSnapshot = struct {
    path: Path,
    sha256: DigestHex,
    contents: FileText,
};

const ReplaceRequest = struct {
    path: Path,
    expected_sha256: DigestHex,
    replacement: FileText,
    rationale: SummaryText,
};

const ReplaceApplied = struct {
    path: Path,
    old_sha256: DigestHex,
    new_sha256: DigestHex,
    already_applied: bool,
    current: DocumentSnapshot,
};

const ReplaceDenied = struct {
    path: Path,
    reason: ReasonText,
};

const ReplaceConflict = struct {
    path: Path,
    expected_sha256: DigestHex,
    actual_sha256: DigestHex,
};

const ReplaceOutcome = union(enum) {
    applied: ReplaceApplied,
    denied: ReplaceDenied,
    conflict: ReplaceConflict,
};

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
        .maximum_request_bytes = 256 * 1024,
        .maximum_result_bytes = 24 * 1024,
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
            .maximum_frames = 48,
            .maximum_state_bytes = 511 * 1024,
            .maximum_machine_fuel = 8_000_000,
        },
    },
);

const Machine = Compiled.Machine;

fn resumeRequest(state: *Machine.State, request: Machine.Request, value: anytype) !void {
    const prepared = try Machine.prepareResume(state.*, request);
    defer Machine.deinitPreparedResume(prepared);
    try Machine.@"resume"(prepared, value);
}

fn digest() !DigestHex {
    return DigestHex.fromSlice(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
}

fn replacementAction() !Action {
    return .{ .replace_file = .{
        .path = try Path.fromSlice("src/example.zig"),
        .expected_sha256 = try digest(),
        .replacement = try FileText.fromSlice("const corrected = true;\n"),
        .rationale = try SummaryText.fromSlice("Exercise the exact Praxis replacement contract."),
    } };
}

fn quotedValueAfter(text: []const u8, section: []const u8, key: []const u8) ![]const u8 {
    const section_start = std.mem.indexOf(u8, text, section) orelse
        return error.MissingSection;
    const section_text = text[section_start..];
    const key_start = std.mem.indexOf(u8, section_text, key) orelse
        return error.MissingKey;
    const value = section_text[key_start + key.len ..];
    const value_end = std.mem.indexOfScalar(u8, value, '"') orelse
        return error.UnterminatedValue;
    return value[0..value_end];
}

fn resultValue(key: []const u8) ![]const u8 {
    const key_start = std.mem.indexOf(u8, release_sources.obstruction_result, key) orelse
        return error.MissingResultKey;
    const value = release_sources.obstruction_result[key_start + key.len ..];
    const value_end = std.mem.indexOfScalar(u8, value, '\n') orelse value.len;
    return value[0..value_end];
}

test "Agent v2.2.0 reaches replacement before the baseline test invariant" {
    try std.testing.expectEqual(@as(u32, 2), Machine.abi_version);
    try std.testing.expectEqualSlices(u8, "ABL_RNF2", &Machine.Manifest.state_image_magic);
    try std.testing.expectEqualStrings(
        "repo.replace.approved.v2",
        Compiled.ActionSites[2].semantic_identity,
    );
    try std.testing.expect(Machine.EffectRow.site(2).Payload == ReplaceRequest);
    try std.testing.expect(Machine.EffectRow.site(2).Resume == ReplaceOutcome);
    var expected_contract_digest: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(
        &expected_contract_digest,
        "79b6bb298d086961b13d97cc7e4ed6a23f6694320d9d66a67b296ee026524dcf",
    );
    try std.testing.expectEqualSlices(
        u8,
        &expected_contract_digest,
        &Machine.EffectRow.site(2).semantic_contract_digest,
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

    try resumeRequest(&state, decision, try replacementAction());

    const effect = switch (try Machine.step(state, &fuel)) {
        .request => |request| request,
        else => return error.UnexpectedMachineStep,
    };
    switch (effect.value) {
        .s2 => |payload| {
            try std.testing.expectEqualStrings("src/example.zig", try payload.path.slice());
            try std.testing.expectEqualStrings("const corrected = true;\n", try payload.replacement.slice());
        },
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

test "the check target binds the exact frozen lock and Agent package" {
    var lock_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(
        release_sources.reference_stack_lock,
        &lock_digest,
        .{},
    );
    var expected_lock_digest: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(
        &expected_lock_digest,
        "d159b0c9a2075cc57d38fa893db68ae416ff68e3988cc8632ae91a3f42853aba",
    );
    try std.testing.expectEqualSlices(u8, &expected_lock_digest, &lock_digest);
    var manifest_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(
        release_sources.package_manifest,
        &manifest_digest,
        .{},
    );
    var expected_manifest_digest: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(
        &expected_manifest_digest,
        "d6fb403ea24241db6a11437a65a7663e9e534394e9419941360a4242bc9dd913",
    );
    try std.testing.expectEqualSlices(u8, &expected_manifest_digest, &manifest_digest);

    const lock_agent_url = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"agent\": {",
        "\"url\": \"",
    );
    const lock_agent_hash = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"agent\": {",
        "\"packageHash\": \"",
    );
    const manifest_agent_url = try quotedValueAfter(
        release_sources.package_manifest,
        ".agent = .{",
        ".url = \"",
    );
    const manifest_agent_hash = try quotedValueAfter(
        release_sources.package_manifest,
        ".agent = .{",
        ".hash = \"",
    );
    try std.testing.expectEqualStrings(lock_agent_url, manifest_agent_url);
    try std.testing.expectEqualStrings(lock_agent_hash, manifest_agent_hash);
}

test "the published obstruction result matches the executable witness" {
    const lock_agent_version = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"tuple\": {",
        "\"agent\": \"",
    );
    try std.testing.expectEqualStrings("praxis_obstruction", try resultValue("result="));
    try std.testing.expectEqualStrings("agent-compiler", try resultValue("owner="));
    try std.testing.expectEqualStrings(
        "zig build check --summary all",
        try resultValue("reproducer="),
    );
    try std.testing.expectEqualStrings(lock_agent_version, try resultValue("released_agent="));
    const result_machine_abi = try std.fmt.parseInt(
        u32,
        try resultValue("boundary_machine_abi="),
        10,
    );
    try std.testing.expectEqual(Machine.abi_version, result_machine_abi);
    try std.testing.expectEqualStrings(
        "ABL_RNF2",
        try resultValue("machine_state="),
    );
    try std.testing.expectEqualStrings(
        "false",
        try resultValue("substrate_changes_applied="),
    );
    try std.testing.expectEqualStrings("false", try resultValue("completion_claimed="));
}
