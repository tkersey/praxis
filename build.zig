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
    const world_dependency = b.dependency("world", .{
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
    const agent_manifest_path = agent_dependency.path("build.zig.zon").getPath3(b, null);
    const agent_manifest = agent_manifest_path.root_dir.handle.readFileAlloc(
        b.graph.io,
        agent_manifest_path.sub_path,
        b.allocator,
        .limited(64 * 1024),
    ) catch @panic("unable to read the pinned Agent package manifest");
    release_sources.addOption(
        []const u8,
        "reference_stack_lock",
        @embedFile("conformance/praxis-v1/reference-stack.lock.json"),
    );
    release_sources.addOption([]const u8, "package_manifest", @embedFile("build.zig.zon"));
    release_sources.addOption([]const u8, "agent_package_manifest", agent_manifest);
    release_sources.addOption(
        []const u8,
        "obstruction_result",
        @embedFile("conformance/praxis-v1/obstructions/agent-pre-effect-admission/result.txt"),
    );
    witness.addOptions("release_sources", release_sources);

    const tests = b.addTest(.{ .root_module = witness });
    const epistemics_tests_module = b.createModule(.{
        .root_source_file = b.path("src/epistemics_test.zig"),
        .target = target,
        .optimize = optimize,
    });
    epistemics_tests_module.addImport("agent", agent_dependency.module("agent"));
    epistemics_tests_module.addImport("boundary", agent_dependency.module("boundary"));
    const epistemics_tests = b.addTest(.{ .root_module = epistemics_tests_module });
    epistemics_tests.stack_size = 1024 * 1024 * 1024;
    const epistemics_check = b.step("check-epistemics", "Compile and test the Praxis epistemic strategy");
    epistemics_check.dependOn(&b.addRunArtifact(epistemics_tests).step);

    const application_module = applicationModule(
        b,
        target,
        optimize,
        agent_dependency.module("agent"),
        agent_dependency.module("boundary"),
        world_dependency.module("world"),
    );
    const application_tests = b.addTest(.{ .root_module = application_module });
    const run_application_tests = b.addRunArtifact(application_tests);

    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .abi = .none,
    });
    const wasm_agent_dependency = b.dependency("agent", .{
        .target = wasm_target,
        .optimize = .ReleaseSmall,
    });
    const wasm_world_dependency = b.dependency("world", .{
        .target = wasm_target,
        .optimize = .ReleaseSmall,
    });
    const wasm_application = applicationModule(
        b,
        wasm_target,
        .ReleaseSmall,
        wasm_agent_dependency.module("agent"),
        wasm_agent_dependency.module("boundary"),
        wasm_world_dependency.module("world"),
    );
    const wasm = b.addExecutable(.{
        .name = "repository-steward.world",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/wasm_main.zig"),
            .target = wasm_target,
            .optimize = .ReleaseSmall,
            .imports = &.{
                .{ .name = "world", .module = wasm_world_dependency.module("world") },
                .{ .name = "praxis_application", .module = wasm_application },
            },
        }),
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    wasm.export_memory = true;
    wasm.stack_size = 128 * 1024 * 1024;
    wasm.initial_memory = @as(u64, 4096) * 64 * 1024;
    wasm.max_memory = @as(u64, 4096) * 64 * 1024;

    const pack_wasm = b.addSystemCommand(&.{"node"});
    pack_wasm.addFileArg(wasm_agent_dependency.path("tools/adequacy/sparse-wasm-data.mjs"));
    pack_wasm.addFileArg(wasm.getEmittedBin());
    const packed_wasm = pack_wasm.addOutputFileArg("repository-steward.world.wasm");

    const manifest_emitter = b.addExecutable(.{
        .name = "repository-steward-manifest",
        .root_module = b.createModule(.{
            .root_source_file = world_dependency.path("src/application_manifest_emit_v1.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "world_application", .module = application_module }},
        }),
    });
    const run_manifest = b.addRunArtifact(manifest_emitter);
    const manifest = run_manifest.addOutputFileArg("repository-steward.manifest.bin");
    const manifest_text = run_manifest.addOutputFileArg("repository-steward.manifest.txt");

    const contract_json = addContractEmitter(
        b,
        "emit-repository-steward-decision-contract-json",
        false,
        agent_dependency.module("agent"),
        agent_dependency.module("boundary"),
    );
    const contract_json_output = b.addRunArtifact(contract_json).captureStdOut(.{
        .basename = "repository-steward.decision-contract.json",
    });
    const contract_binary = addContractEmitter(
        b,
        "emit-repository-steward-decision-contract-binary",
        true,
        agent_dependency.module("agent"),
        agent_dependency.module("boundary"),
    );
    const contract_binary_output = b.addRunArtifact(contract_binary).captureStdOut(.{
        .basename = "repository-steward.decision-contract.bin",
    });
    const binding_manifest = b.addExecutable(.{
        .name = "emit-repository-steward-binding-manifest",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/emit_binding_manifest.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "boundary", .module = agent_dependency.module("boundary") },
                .{ .name = "praxis_application", .module = application_module },
                .{ .name = "world", .module = world_dependency.module("world") },
            },
        }),
    });
    const run_binding_manifest = b.addRunArtifact(binding_manifest);
    const binding_manifest_output = run_binding_manifest.captureStdOut(.{
        .basename = "repository-steward.binding-manifest.json",
    });

    const definition_module = b.createModule(.{
        .root_source_file = b.path("src/definition.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "agent", .module = agent_dependency.module("agent") },
            .{ .name = "boundary", .module = agent_dependency.module("boundary") },
        },
    });
    const initial_args_module = b.createModule(.{
        .root_source_file = b.path("src/emit_initial_args.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "boundary", .module = agent_dependency.module("boundary") },
            .{ .name = "praxis_definition", .module = definition_module },
        },
    });
    const initial_args = b.addExecutable(.{
        .name = "praxis-initial-args",
        .root_module = initial_args_module,
    });
    const initial_args_tests = b.addTest(.{ .root_module = initial_args_module });
    const run_initial_args_tests = b.addRunArtifact(initial_args_tests);

    const type_measurements = b.addExecutable(.{
        .name = "emit-repository-steward-type-measurements",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/emit_type_measurements.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "praxis_definition", .module = definition_module }},
        }),
    });
    const type_measurements_output = b.addRunArtifact(type_measurements).captureStdOut(.{
        .basename = "repository-steward.type-measurements.txt",
    });

    const codec_vectors = b.addExecutable(.{
        .name = "emit-repository-steward-codec-vectors",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/emit_codec_vectors.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "boundary", .module = agent_dependency.module("boundary") },
                .{ .name = "praxis_definition", .module = definition_module },
            },
        }),
    });
    codec_vectors.stack_size = 1024 * 1024 * 1024;
    const run_codec_vectors = b.addRunArtifact(codec_vectors);
    const codec_vectors_output = run_codec_vectors.captureStdOut(.{
        .basename = "repository-steward.codec-vectors.json",
    });

    const artifact_check = b.addSystemCommand(&.{"node"});
    artifact_check.addFileArg(wasm_world_dependency.path("scripts/world_application_v1_artifact_check.mjs"));
    artifact_check.addFileArg(packed_wasm);
    artifact_check.addFileArg(manifest);
    artifact_check.addArg("4096");
    artifact_check.addArg("4096");

    const install_wasm = b.addInstallFile(
        packed_wasm,
        "repository-steward/repository-steward.world.wasm",
    );
    install_wasm.step.dependOn(&artifact_check.step);
    const install_manifest = b.addInstallFile(
        manifest,
        "repository-steward/repository-steward.manifest.bin",
    );
    install_manifest.step.dependOn(&artifact_check.step);
    const install_manifest_text = b.addInstallFile(
        manifest_text,
        "repository-steward/repository-steward.manifest.txt",
    );
    install_manifest_text.step.dependOn(&artifact_check.step);
    const install_contract_json = b.addInstallFile(
        contract_json_output,
        "repository-steward/repository-steward.decision-contract.json",
    );
    const install_contract_binary = b.addInstallFile(
        contract_binary_output,
        "repository-steward/repository-steward.decision-contract.bin",
    );
    const install_binding_manifest = b.addInstallFile(
        binding_manifest_output,
        "repository-steward/repository-steward.binding-manifest.json",
    );
    const install_type_measurements = b.addInstallFile(
        type_measurements_output,
        "repository-steward/repository-steward.type-measurements.txt",
    );
    const install_codec_vectors = b.addInstallFile(
        codec_vectors_output,
        "repository-steward/repository-steward.codec-vectors.json",
    );
    const install_initial_args = b.addInstallArtifact(initial_args, .{});

    const check = b.step("check", "Run the Praxis v1 Agent action-admission regression proof");
    check.dependOn(&b.addRunArtifact(tests).step);
    check.dependOn(&b.addRunArtifact(epistemics_tests).step);
    check.dependOn(&run_application_tests.step);
    check.dependOn(&run_initial_args_tests.step);
    check.dependOn(&artifact_check.step);
    check.dependOn(&contract_json.step);
    check.dependOn(&contract_binary.step);
    check.dependOn(&run_binding_manifest.step);
    check.dependOn(&type_measurements.step);
    check.dependOn(&run_codec_vectors.step);
    const text_comparison_obstruction = b.addSystemCommand(&.{
        "node",
        "conformance/praxis-v1/obstructions/agent-text-comparison/reproducer/verify.mjs",
    });
    check.dependOn(&text_comparison_obstruction.step);

    b.getInstallStep().dependOn(&install_wasm.step);
    b.getInstallStep().dependOn(&install_manifest.step);
    b.getInstallStep().dependOn(&install_manifest_text.step);
    b.getInstallStep().dependOn(&install_contract_json.step);
    b.getInstallStep().dependOn(&install_contract_binary.step);
    b.getInstallStep().dependOn(&install_binding_manifest.step);
    b.getInstallStep().dependOn(&install_type_measurements.step);
    b.getInstallStep().dependOn(&install_codec_vectors.step);
    b.getInstallStep().dependOn(&install_initial_args.step);
}

fn applicationModule(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    agent: *std.Build.Module,
    boundary: *std.Build.Module,
    world: *std.Build.Module,
) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = b.path("src/application.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "agent", .module = agent },
            .{ .name = "boundary", .module = boundary },
            .{ .name = "world", .module = world },
        },
    });
}

fn addContractEmitter(
    b: *std.Build,
    name: []const u8,
    binary: bool,
    agent: *std.Build.Module,
    boundary: *std.Build.Module,
) *std.Build.Step.Compile {
    const options = b.addOptions();
    options.addOption(bool, "binary", binary);
    const module = b.createModule(.{
        .root_source_file = b.path("src/emit_decision_contract.zig"),
        .target = b.graph.host,
        .optimize = .ReleaseSafe,
        .imports = &.{
            .{ .name = "agent", .module = agent },
            .{ .name = "boundary", .module = boundary },
            .{ .name = "emit_contract_options", .module = options.createModule() },
        },
    });
    return b.addExecutable(.{ .name = name, .root_module = module });
}
