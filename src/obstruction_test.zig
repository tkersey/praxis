const std = @import("std");
const builtin = @import("builtin");
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
            1 => flow.productReplace(
                0,
                memory,
                flow.constant(bool, context.false_index),
            ),
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

fn unsignedValueAfter(text: []const u8, section: []const u8, key: []const u8) !u32 {
    const section_start = std.mem.indexOf(u8, text, section) orelse
        return error.MissingSection;
    const section_text = text[section_start..];
    const key_start = std.mem.indexOf(u8, section_text, key) orelse
        return error.MissingKey;
    const value = section_text[key_start + key.len ..];
    const value_end = std.mem.indexOfAny(u8, value, ",\n") orelse value.len;
    return std.fmt.parseInt(u32, std.mem.trim(u8, value[0..value_end], " \t\r"), 10);
}

const ArchiveKind = enum {
    source,
    runtime,
    deterministic,
};

fn expectArchiveVersionBound(
    lock: []const u8,
    tuple_key: []const u8,
    archive_section: []const u8,
    repository: []const u8,
    kind: ArchiveKind,
) !void {
    const version = try quotedValueAfter(lock, "\"tuple\": {", tuple_key);
    const archive_url = try quotedValueAfter(lock, archive_section, "\"url\": \"");
    const archive_root = try quotedValueAfter(lock, archive_section, "\"root\": \"");
    var expected_url_buffer: [256]u8 = undefined;
    const expected_url = switch (kind) {
        .source => try std.fmt.bufPrint(
            &expected_url_buffer,
            "https://github.com/tkersey/{s}/archive/refs/tags/v{s}.tar.gz",
            .{ repository, version },
        ),
        .runtime => try std.fmt.bufPrint(
            &expected_url_buffer,
            "https://github.com/tkersey/{s}/releases/download/v{s}/{s}-v{s}-runtime.tar.gz",
            .{ repository, version, repository, version },
        ),
        .deterministic => try std.fmt.bufPrint(
            &expected_url_buffer,
            "https://github.com/tkersey/{s}/releases/download/v{s}/{s}-v{s}-deterministic.tar.gz",
            .{ repository, version, repository, version },
        ),
    };
    var expected_root_buffer: [128]u8 = undefined;
    const expected_root = switch (kind) {
        .source => try std.fmt.bufPrint(
            &expected_root_buffer,
            "{s}-{s}",
            .{ repository, version },
        ),
        .runtime => try std.fmt.bufPrint(
            &expected_root_buffer,
            "{s}-v{s}-runtime",
            .{ repository, version },
        ),
        .deterministic => try std.fmt.bufPrint(
            &expected_root_buffer,
            "{s}-v{s}-deterministic",
            .{ repository, version },
        ),
    };
    try std.testing.expectEqualStrings(expected_url, archive_url);
    try std.testing.expectEqualStrings(expected_root, archive_root);
}

fn resultValueFrom(text: []const u8, key: []const u8) ![]const u8 {
    var found: ?[]const u8 = null;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        const equals = std.mem.indexOfScalar(u8, line, '=') orelse continue;
        if (!std.mem.eql(u8, line[0..equals], key)) continue;
        if (found != null) return error.DuplicateResultKey;
        found = line[equals + 1 ..];
    }
    return found orelse error.MissingResultKey;
}

fn resultValue(key: []const u8) ![]const u8 {
    return resultValueFrom(release_sources.obstruction_result, key);
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
    const lock_boundary_url = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"boundary\": {",
        "\"url\": \"",
    );
    const lock_boundary_hash = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"boundary\": {",
        "\"packageHash\": \"",
    );
    const agent_boundary_url = try quotedValueAfter(
        release_sources.agent_package_manifest,
        ".boundary = .{",
        ".url = \"",
    );
    const agent_boundary_hash = try quotedValueAfter(
        release_sources.agent_package_manifest,
        ".boundary = .{",
        ".hash = \"",
    );
    const lock_world_url = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"world\": {",
        "\"url\": \"",
    );
    const lock_world_hash = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"world\": {",
        "\"packageHash\": \"",
    );
    const agent_world_url = try quotedValueAfter(
        release_sources.agent_package_manifest,
        ".world = .{",
        ".url = \"",
    );
    const agent_world_hash = try quotedValueAfter(
        release_sources.agent_package_manifest,
        ".world = .{",
        ".hash = \"",
    );
    try std.testing.expectEqualStrings(lock_agent_url, manifest_agent_url);
    try std.testing.expectEqualStrings(lock_agent_hash, manifest_agent_hash);
    try std.testing.expectEqualStrings(lock_boundary_url, agent_boundary_url);
    try std.testing.expectEqualStrings(lock_boundary_hash, agent_boundary_hash);
    try std.testing.expectEqualStrings(lock_world_url, agent_world_url);
    try std.testing.expectEqualStrings(lock_world_hash, agent_world_hash);
    try expectArchiveVersionBound(
        release_sources.reference_stack_lock,
        "\"agent\": \"",
        "\"agent\": {",
        "agent",
        .source,
    );
    try expectArchiveVersionBound(
        release_sources.reference_stack_lock,
        "\"boundary\": \"",
        "\"boundary\": {",
        "boundary",
        .source,
    );
    try expectArchiveVersionBound(
        release_sources.reference_stack_lock,
        "\"world\": \"",
        "\"world\": {",
        "world",
        .source,
    );
    try expectArchiveVersionBound(
        release_sources.reference_stack_lock,
        "\"worldHost\": \"",
        "\"worldHost\": {",
        "world-host",
        .runtime,
    );
    try expectArchiveVersionBound(
        release_sources.reference_stack_lock,
        "\"worldCapabilities\": \"",
        "\"worldCapabilities\": {",
        "world-capabilities",
        .deterministic,
    );
}

test "the published obstruction result matches the executable witness" {
    const lock_agent_version = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"tuple\": {",
        "\"agent\": \"",
    );
    const lock_boundary_version = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"tuple\": {",
        "\"boundary\": \"",
    );
    const lock_zig_version = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"tuple\": {",
        "\"zig\": \"",
    );
    const lock_machine_state = try quotedValueAfter(
        release_sources.reference_stack_lock,
        "\"tuple\": {",
        "\"machineStateFormat\": \"",
    );
    const lock_machine_abi = try unsignedValueAfter(
        release_sources.reference_stack_lock,
        "\"tuple\": {",
        "\"machineAbi\": ",
    );
    try std.testing.expectEqualStrings(agent.package_version, lock_agent_version);
    var zig_version_buffer: [64]u8 = undefined;
    const active_zig_version = try std.fmt.bufPrint(
        &zig_version_buffer,
        "{f}",
        .{builtin.zig_version},
    );
    try std.testing.expectEqualStrings(active_zig_version, lock_zig_version);
    try std.testing.expectEqual(Machine.abi_version, lock_machine_abi);
    try std.testing.expectEqualStrings(&Machine.Manifest.state_image_magic, lock_machine_state);
    var boundary_identity_buffer: [128]u8 = undefined;
    const boundary_identity = try std.fmt.bufPrint(
        &boundary_identity_buffer,
        "tkersey/boundary@v{s}",
        .{lock_boundary_version},
    );
    var expected_boundary_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(boundary_identity, &expected_boundary_digest, .{});
    try std.testing.expectEqualSlices(
        u8,
        &expected_boundary_digest,
        &Compiled.Manifest.boundary_package_digest,
    );
    try std.testing.expectEqualStrings("praxis_obstruction", try resultValue("result"));
    try std.testing.expectEqualStrings("agent-compiler", try resultValue("owner"));
    try std.testing.expectEqualStrings(
        "zig build check --summary all",
        try resultValue("reproducer"),
    );
    try std.testing.expectEqualStrings(lock_agent_version, try resultValue("released_agent"));
    const result_machine_abi = try std.fmt.parseInt(
        u32,
        try resultValue("boundary_machine_abi"),
        10,
    );
    try std.testing.expectEqual(Machine.abi_version, result_machine_abi);
    try std.testing.expectEqualStrings(
        "ABL_RNF2",
        try resultValue("machine_state"),
    );
    try std.testing.expectEqualStrings(
        "false",
        try resultValue("substrate_changes_applied"),
    );
    try std.testing.expectEqualStrings("false", try resultValue("completion_claimed"));
}

test "published result keys are exact and unique" {
    try std.testing.expectError(
        error.MissingResultKey,
        resultValueFrom("not_completion_claimed=false\n", "completion_claimed"),
    );
    try std.testing.expectError(
        error.DuplicateResultKey,
        resultValueFrom("completion_claimed=false\ncompletion_claimed=true\n", "completion_claimed"),
    );
}
