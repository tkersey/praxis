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

    pub fn emitActionAllowed(
        comptime _: type,
        comptime _: anytype,
        flow: anytype,
        memory: anytype,
        action: anytype,
        comptime _: anytype,
    ) agent.Value(bool) {
        const replacing = flow.sumTagIs(1, action);
        const baseline_test_observed = flow.productExtract(0, memory);
        return flow.booleanOr(flow.booleanNot(replacing), baseline_test_observed);
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

const CompareArgs = struct {
    left: Path,
    right: Path,
};

fn lowerPathComparison() type {
    const Builder = agent.Flow(.{ .schema_types = .{ CompareArgs, Path } });
    comptime var flow = Builder.init("praxis-path-comparison");
    const args = flow.begin(CompareArgs);
    const ordering = flow.textCompare(
        flow.productExtract(0, args),
        flow.productExtract(1, args),
    );
    flow.returnValue(ordering);
    return flow.finish(i8);
}

const PathComparisonBody = struct {
    const Lowering = lowerPathComparison();
    pub const InitialArgs = CompareArgs;
    pub const Result = i8;
    pub const Failure = enum { impossible };
    pub const effect_sites = boundary.effect.row(.{});
    pub const schema_types = Lowering.schema_types;
    pub const control_ir = Lowering.control_ir;
};

const PathComparisonMachine = boundary.program(
    "praxis-path-comparison",
    PathComparisonBody,
).compile(.{
    .maximum_frames = 2,
    .maximum_state_bytes = 2048,
    .maximum_machine_fuel = 32,
});

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

test "Agent v2.5.0 exposes typed canonical Path comparison" {
    inline for (.{
        .{ "src/a.zig", "src/a.zig", @as(i8, 0) },
        .{ "src/a.zig", "src/b.zig", @as(i8, -1) },
        .{ "src/b.zig", "src/a.zig", @as(i8, 1) },
    }) |fixture| {
        const state = try PathComparisonMachine.initialState(
            std.testing.allocator,
            .{
                .left = try Path.fromSlice(fixture[0]),
                .right = try Path.fromSlice(fixture[1]),
            },
        );
        defer PathComparisonMachine.deinitState(state);
        var fuel: u64 = 16;
        const done = switch (try PathComparisonMachine.step(state, &fuel)) {
            .done => |result| result,
            else => return error.UnexpectedMachineStep,
        };
        defer done.deinit();
        try std.testing.expectEqual(fixture[2], done.value().*);
    }
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

const SourceArchive = struct {
    url: []const u8,
    sha256: []const u8,
    packageHash: []const u8,
    root: []const u8,
};

const RuntimeArchive = struct {
    url: []const u8,
    sha256: []const u8,
    root: []const u8,
};

const ReferenceStackLock = struct {
    format: []const u8,
    tuple: struct {
        agent: []const u8,
        boundary: []const u8,
        world: []const u8,
        worldHost: []const u8,
        worldCapabilities: []const u8,
        zig: []const u8,
        machineAbi: u32,
        machineStateFormat: []const u8,
        applicationAbi: u32,
        frame: u32,
        effectProtocol: u32,
        maximumPendingEffects: u32,
    },
    archives: struct {
        agent: SourceArchive,
        boundary: SourceArchive,
        world: SourceArchive,
        worldHost: RuntimeArchive,
        worldCapabilities: RuntimeArchive,
    },
};

const ArchiveKind = enum {
    source,
    runtime,
    deterministic,
};

fn expectArchiveVersionBound(
    version: []const u8,
    archive_url: []const u8,
    archive_root: []const u8,
    repository: []const u8,
    kind: ArchiveKind,
) !void {
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

const ObstructionResult = struct {
    result: []const u8,
    owner: []const u8,
    reproducer: []const u8,
    released_agent: []const u8,
    boundary_machine_abi: []const u8,
    machine_state: []const u8,
    substrate_changes_applied: []const u8,
    completion_claimed: []const u8,
};

fn parseObstructionResult(text: []const u8) !ObstructionResult {
    if (!std.mem.endsWith(u8, text, "\n") or text.len == 1) {
        return error.MalformedResultLine;
    }
    var parsed: ObstructionResult = undefined;
    var seen = [_]bool{false} ** 8;
    var lines = std.mem.splitScalar(u8, text[0 .. text.len - 1], '\n');
    while (lines.next()) |line| {
        const equals = std.mem.indexOfScalar(u8, line, '=') orelse
            return error.MalformedResultLine;
        const key = line[0..equals];
        const value = line[equals + 1 ..];
        if (key.len == 0 or value.len == 0 or std.mem.indexOfScalar(u8, value, '=') != null) {
            return error.MalformedResultLine;
        }
        const index: usize = if (std.mem.eql(u8, key, "result"))
            0
        else if (std.mem.eql(u8, key, "owner"))
            1
        else if (std.mem.eql(u8, key, "reproducer"))
            2
        else if (std.mem.eql(u8, key, "released_agent"))
            3
        else if (std.mem.eql(u8, key, "boundary_machine_abi"))
            4
        else if (std.mem.eql(u8, key, "machine_state"))
            5
        else if (std.mem.eql(u8, key, "substrate_changes_applied"))
            6
        else if (std.mem.eql(u8, key, "completion_claimed"))
            7
        else
            return error.UnknownResultKey;
        if (seen[index]) return error.DuplicateResultKey;
        seen[index] = true;
        switch (index) {
            0 => parsed.result = value,
            1 => parsed.owner = value,
            2 => parsed.reproducer = value,
            3 => parsed.released_agent = value,
            4 => parsed.boundary_machine_abi = value,
            5 => parsed.machine_state = value,
            6 => parsed.substrate_changes_applied = value,
            7 => parsed.completion_claimed = value,
            else => unreachable,
        }
    }
    for (seen) |present| {
        if (!present) return error.MissingResultKey;
    }
    return parsed;
}

test "Agent v2.5.0 rejects replacement before the baseline test invariant" {
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

    switch (try Machine.step(state, &fuel)) {
        .failed => |failure| switch (failure) {
            .authored => |authored| try std.testing.expectEqual(
                Failure.invalid_variant,
                authored,
            ),
            else => return error.ExpectedAuthoredAdmissionFailure,
        },
        .request => return error.ForbiddenReplacementRequest,
        else => return error.ExpectedAdmissionFailure,
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
        "2faa97b6ea400bd5ede68ff0db1d5d463deec104253516251990dbc6cf254d12",
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
        "26b7b3455d7e3a20a8952120a6ece8581e3063a4c92575dfd0c471cdeaa67b4a",
    );
    try std.testing.expectEqualSlices(u8, &expected_manifest_digest, &manifest_digest);

    const parsed_lock = try std.json.parseFromSlice(
        ReferenceStackLock,
        std.testing.allocator,
        release_sources.reference_stack_lock,
        .{},
    );
    defer parsed_lock.deinit();
    const lock = parsed_lock.value;
    try std.testing.expectEqualStrings("praxis-reference-stack-lock-v1", lock.format);

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
    try std.testing.expectEqualStrings(lock.archives.agent.url, manifest_agent_url);
    try std.testing.expectEqualStrings(lock.archives.agent.packageHash, manifest_agent_hash);
    try std.testing.expectEqualStrings(lock.archives.boundary.url, agent_boundary_url);
    try std.testing.expectEqualStrings(lock.archives.boundary.packageHash, agent_boundary_hash);
    try std.testing.expectEqualStrings(lock.archives.world.url, agent_world_url);
    try std.testing.expectEqualStrings(lock.archives.world.packageHash, agent_world_hash);
    try expectArchiveVersionBound(
        lock.tuple.agent,
        lock.archives.agent.url,
        lock.archives.agent.root,
        "agent",
        .source,
    );
    try expectArchiveVersionBound(
        lock.tuple.boundary,
        lock.archives.boundary.url,
        lock.archives.boundary.root,
        "boundary",
        .source,
    );
    try expectArchiveVersionBound(
        lock.tuple.world,
        lock.archives.world.url,
        lock.archives.world.root,
        "world",
        .source,
    );
    try expectArchiveVersionBound(
        lock.tuple.worldHost,
        lock.archives.worldHost.url,
        lock.archives.worldHost.root,
        "world-host",
        .runtime,
    );
    try expectArchiveVersionBound(
        lock.tuple.worldCapabilities,
        lock.archives.worldCapabilities.url,
        lock.archives.worldCapabilities.root,
        "world-capabilities",
        .deterministic,
    );
}

test "the published obstruction result remains bound to the historical tuple" {
    const parsed_lock = try std.json.parseFromSlice(
        ReferenceStackLock,
        std.testing.allocator,
        release_sources.reference_stack_lock,
        .{},
    );
    defer parsed_lock.deinit();
    const lock = parsed_lock.value;
    try std.testing.expectEqualStrings(agent.package_version, lock.tuple.agent);
    var zig_version_buffer: [64]u8 = undefined;
    const active_zig_version = try std.fmt.bufPrint(
        &zig_version_buffer,
        "{f}",
        .{builtin.zig_version},
    );
    try std.testing.expectEqualStrings(active_zig_version, lock.tuple.zig);
    try std.testing.expectEqual(Machine.abi_version, lock.tuple.machineAbi);
    try std.testing.expectEqualStrings(&Machine.Manifest.state_image_magic, lock.tuple.machineStateFormat);
    var boundary_identity_buffer: [128]u8 = undefined;
    const boundary_identity = try std.fmt.bufPrint(
        &boundary_identity_buffer,
        "tkersey/boundary@v{s}",
        .{lock.tuple.boundary},
    );
    var expected_boundary_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(boundary_identity, &expected_boundary_digest, .{});
    try std.testing.expectEqualSlices(
        u8,
        &expected_boundary_digest,
        &Compiled.Manifest.boundary_package_digest,
    );
    const result = try parseObstructionResult(release_sources.obstruction_result);
    try std.testing.expectEqualStrings("praxis_obstruction", result.result);
    try std.testing.expectEqualStrings("agent-compiler", result.owner);
    try std.testing.expectEqualStrings(
        "zig build check --summary all",
        result.reproducer,
    );
    try std.testing.expectEqualStrings("2.2.0", result.released_agent);
    try std.testing.expect(!std.mem.eql(u8, lock.tuple.agent, result.released_agent));
    const result_machine_abi = try std.fmt.parseInt(
        u32,
        result.boundary_machine_abi,
        10,
    );
    try std.testing.expectEqual(Machine.abi_version, result_machine_abi);
    try std.testing.expectEqualStrings(
        "ABL_RNF2",
        result.machine_state,
    );
    try std.testing.expectEqualStrings(
        "false",
        result.substrate_changes_applied,
    );
    try std.testing.expectEqualStrings("false", result.completion_claimed);
}

test "published result keys are exact and unique" {
    try std.testing.expectError(
        error.MissingResultKey,
        parseObstructionResult("result=praxis_obstruction\n"),
    );
    try std.testing.expectError(
        error.DuplicateResultKey,
        parseObstructionResult(
            "result=praxis_obstruction\n" ++
                "result=praxis_obstruction\n",
        ),
    );
    try std.testing.expectError(
        error.UnknownResultKey,
        parseObstructionResult("unexpected=true\n"),
    );
    try std.testing.expectError(
        error.MalformedResultLine,
        parseObstructionResult("completion_claimed\n"),
    );
}
