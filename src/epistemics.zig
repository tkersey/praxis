pub fn WorkingSet(comptime agent: type, comptime T: type) type {
    return struct {
        pub const semantic_identity = "agent.epistemics.praxis-zig-working-set.lowering.v1";
        pub const lowering_complexity: usize = 25;

        const DocumentLookup = struct {
            found: agent.Value(bool),
            index: agent.Value(u32),
        };
        const PathLookup = DocumentLookup;
        const PathAdmission = struct {
            allowed: agent.Value(bool),
            known: agent.Value(bool),
        };
        const empty_path: T.Path = .{};

        pub fn constantValues(comptime _: type, comptime _: anytype) @TypeOf(.{
            @as(u32, T.maximum_documents),
            @as(u32, T.maximum_mutation_operations),
            @as(u32, T.maximum_changed_files),
            T.Failure.capacity_exceeded,
            T.Failure.invalid_index,
            empty_path,
            @as(u32, 2),
            @as(u32, 3),
        }) {
            return .{
                @as(u32, T.maximum_documents),
                @as(u32, T.maximum_mutation_operations),
                @as(u32, T.maximum_changed_files),
                T.Failure.capacity_exceeded,
                T.Failure.invalid_index,
                empty_path,
                @as(u32, 2),
                @as(u32, 3),
            };
        }

        pub fn constantContext(comptime _: type, comptime _: anytype, comptime base: u16) type {
            return struct {
                pub const zero_index: u16 = 0;
                pub const one_index: u16 = 1;
                pub const invalid_variant_index: u16 = 8;
                pub const initial_memory_index: u16 = 10;
                pub const true_index: u16 = 11;
                pub const false_index: u16 = 12;
                pub const maximum_documents_index: u16 = base;
                pub const maximum_mutations_index: u16 = base + 1;
                pub const maximum_changed_files_index: u16 = base + 2;
                pub const capacity_exceeded_index: u16 = base + 3;
                pub const invalid_index_index: u16 = base + 4;
                pub const empty_path_index: u16 = base + 5;
                pub const two_index: u16 = base + 6;
                pub const three_index: u16 = base + 7;
            };
        }

        pub fn validate(comptime Definition: type, comptime _: anytype) void {
            if (Definition.Action != T.Action or Definition.Observation != T.Observation) {
                @compileError("Praxis working-set epistemics requires the repository-steward action algebra");
            }
        }

        pub fn Memory(comptime _: type, comptime _: anytype) type {
            return T.Memory;
        }

        pub fn DecisionView(comptime _: type, comptime _: anytype) type {
            return T.DecisionView;
        }

        pub fn StateSchemaTypes(comptime _: type, comptime _: anytype) @TypeOf(.{
            T.Memory,
            T.DecisionView,
            T.DecisionEvidence,
            T.ReadEvidence,
            T.ListResult,
            ?T.ListResult,
            T.Documents,
            T.DocumentSnapshot,
            T.SearchResult,
            ?T.SearchResult,
            T.TestResult,
            ?T.TestResult,
            T.ReplaceSummary,
            ?T.ReplaceSummary,
            T.ReplaceOutcome,
            T.ReplaceApplied,
            T.ReplaceDenied,
            T.ReplaceConflict,
            T.Mutations,
            T.MutationSummary,
            T.ChangedFiles,
            T.Path,
            T.DigestHex,
        }) {
            return .{
                T.Memory,
                T.DecisionView,
                T.DecisionEvidence,
                T.ReadEvidence,
                T.ListResult,
                ?T.ListResult,
                T.Documents,
                T.DocumentSnapshot,
                T.SearchResult,
                ?T.SearchResult,
                T.TestResult,
                ?T.TestResult,
                T.ReplaceSummary,
                ?T.ReplaceSummary,
                T.ReplaceOutcome,
                T.ReplaceApplied,
                T.ReplaceDenied,
                T.ReplaceConflict,
                T.Mutations,
                T.MutationSummary,
                T.ChangedFiles,
                T.Path,
                T.DigestHex,
            };
        }

        pub fn initialMemory(comptime _: type, comptime _: anytype) T.Memory {
            return .{
                .listing = null,
                .documents = T.Documents.empty(),
                .latest_search = null,
                .latest_test = null,
                .latest_replace = null,
                .mutations = T.Mutations.empty(),
                .baseline_test_observed = false,
                .latest_test_passed = false,
                .mutation_count = 0,
                .last_test_mutation_count = 0,
                .test_count = 0,
                .latest_read = .{
                    .path = empty_path,
                    .observed_test_count = 0,
                },
            };
        }

        fn textEqual(flow: anytype, left: anytype, right: anytype) agent.Value(bool) {
            return flow.compareEqZero(flow.textCompare(left, right));
        }

        fn replaceMemoryField(flow: anytype, memory: anytype, comptime index: usize, value: anytype) agent.Value(T.Memory) {
            return flow.productReplace(index, memory, value);
        }

        fn findDocument(flow: anytype, documents: anytype, path: anytype, comptime context: anytype) DocumentLookup {
            const header = flow.block(.loop_header, .{ T.Documents, T.Path, u32, u32 });
            const inspect = flow.block(.segment, .{ T.Documents, T.Path, u32, u32 });
            const found = flow.block(.segment, .{u32});
            const absent = flow.block(.segment, .{});
            const joined = flow.block(.segment, .{ bool, u32 });
            const length = flow.vectorLength(documents);
            flow.jump(header, .{ documents, path, flow.constant(u32, context.zero_index), length });

            const values = flow.enter(header);
            flow.branch(
                flow.integerGreaterEqual(values[2], values[3]),
                absent,
                .{},
                inspect,
                values,
            );

            const inspected = flow.enter(inspect);
            const document = flow.vectorGet(inspected[0], inspected[2]);
            flow.branch(
                textEqual(flow, flow.productExtract(0, document), inspected[1]),
                found,
                .{inspected[2]},
                header,
                .{
                    inspected[0],
                    inspected[1],
                    flow.integerAdd(inspected[2], flow.constant(u32, context.one_index)),
                    inspected[3],
                },
            );

            const found_values = flow.enter(found);
            flow.jump(joined, .{
                flow.constant(bool, context.true_index),
                found_values[0],
            });

            _ = flow.enter(absent);
            flow.jump(joined, .{
                flow.constant(bool, context.false_index),
                flow.constant(u32, context.zero_index),
            });

            const result = flow.enter(joined);
            return .{ .found = result[0], .index = result[1] };
        }

        fn findPath(flow: anytype, paths: anytype, path: anytype, comptime context: anytype) PathLookup {
            const Vector = @TypeOf(paths).Type;
            const header = flow.block(.loop_header, .{ Vector, T.Path, u32, u32 });
            const inspect = flow.block(.segment, .{ Vector, T.Path, u32, u32 });
            const found = flow.block(.segment, .{u32});
            const absent = flow.block(.segment, .{});
            const joined = flow.block(.segment, .{ bool, u32 });
            const length = flow.vectorLength(paths);
            flow.jump(header, .{ paths, path, flow.constant(u32, context.zero_index), length });

            const values = flow.enter(header);
            flow.branch(flow.integerGreaterEqual(values[2], values[3]), absent, .{}, inspect, values);

            const inspected = flow.enter(inspect);
            const candidate = flow.vectorGet(inspected[0], inspected[2]);
            flow.branch(
                textEqual(flow, candidate, inspected[1]),
                found,
                .{inspected[2]},
                header,
                .{
                    inspected[0],
                    inspected[1],
                    flow.integerAdd(inspected[2], flow.constant(u32, context.one_index)),
                    inspected[3],
                },
            );

            const found_values = flow.enter(found);
            flow.jump(joined, .{ flow.constant(bool, context.true_index), found_values[0] });
            _ = flow.enter(absent);
            flow.jump(joined, .{
                flow.constant(bool, context.false_index),
                flow.constant(u32, context.zero_index),
            });
            const result = flow.enter(joined);
            return .{ .found = result[0], .index = result[1] };
        }

        fn distinctPathAdmission(flow: anytype, mutations: anytype, candidate: anytype, comptime context: anytype) PathAdmission {
            const State = .{
                T.Mutations,
                T.Path,
                T.Path,
                T.Path,
                T.Path,
                T.Path,
                bool,
                u32,
                u32,
                u32,
            };
            const Step = State ++ .{T.Path};
            const header = flow.block(.loop_header, State);
            const inspect = flow.block(.segment, State);
            const classify = flow.block(.segment, Step);
            const append = flow.block(.segment, Step);
            const reject = flow.block(.segment, .{});
            const joined = flow.block(.segment, .{ bool, bool });
            const empty = flow.constant(T.Path, context.empty_path_index);
            flow.jump(header, .{
                mutations,
                candidate,
                empty,
                empty,
                empty,
                empty,
                flow.constant(bool, context.false_index),
                flow.constant(u32, context.zero_index),
                flow.constant(u32, context.zero_index),
                flow.vectorLength(mutations),
            });

            const values = flow.enter(header);
            const done = flow.integerGreaterEqual(values[8], values[9]);
            const available = flow.booleanOr(
                values[6],
                flow.booleanNot(flow.integerGreaterEqual(
                    values[7],
                    flow.constant(u32, context.maximum_changed_files_index),
                )),
            );
            flow.branch(done, joined, .{ available, values[6] }, inspect, values);

            const inspected = flow.enter(inspect);
            const mutation = flow.vectorGet(inspected[0], inspected[8]);
            const path = flow.productExtract(0, mutation);
            const one = flow.constant(u32, context.one_index);
            const two = flow.constant(u32, context.two_index);
            const three = flow.constant(u32, context.three_index);
            const found = flow.booleanOr(
                flow.booleanAnd(
                    flow.integerGreaterEqual(inspected[7], one),
                    textEqual(flow, path, inspected[2]),
                ),
                flow.booleanOr(
                    flow.booleanAnd(
                        flow.integerGreaterEqual(inspected[7], two),
                        textEqual(flow, path, inspected[3]),
                    ),
                    flow.booleanOr(
                        flow.booleanAnd(
                            flow.integerGreaterEqual(inspected[7], three),
                            textEqual(flow, path, inspected[4]),
                        ),
                        flow.booleanAnd(
                            flow.integerGreaterEqual(
                                inspected[7],
                                flow.constant(u32, context.maximum_changed_files_index),
                            ),
                            textEqual(flow, path, inspected[5]),
                        ),
                    ),
                ),
            );
            const candidate_found = flow.booleanOr(
                inspected[6],
                textEqual(flow, path, inspected[1]),
            );
            flow.branch(
                found,
                header,
                .{
                    inspected[0],
                    inspected[1],
                    inspected[2],
                    inspected[3],
                    inspected[4],
                    inspected[5],
                    candidate_found,
                    inspected[7],
                    flow.integerAdd(inspected[8], one),
                    inspected[9],
                },
                classify,
                .{
                    inspected[0],
                    inspected[1],
                    inspected[2],
                    inspected[3],
                    inspected[4],
                    inspected[5],
                    candidate_found,
                    inspected[7],
                    inspected[8],
                    inspected[9],
                    path,
                },
            );

            const classified = flow.enter(classify);
            flow.branch(
                flow.integerGreaterEqual(
                    classified[7],
                    flow.constant(u32, context.maximum_changed_files_index),
                ),
                reject,
                .{},
                append,
                classified,
            );
            _ = flow.enter(reject);
            flow.jump(joined, .{
                flow.constant(bool, context.false_index),
                flow.constant(bool, context.false_index),
            });

            const appended = flow.enter(append);
            flow.jump(header, .{
                appended[0],
                appended[1],
                flow.select(flow.compareEqZero(appended[7]), appended[10], appended[2]),
                flow.select(flow.integerEqual(appended[7], one), appended[10], appended[3]),
                flow.select(flow.integerEqual(appended[7], two), appended[10], appended[4]),
                flow.select(flow.integerEqual(appended[7], three), appended[10], appended[5]),
                appended[6],
                flow.integerAdd(appended[7], one),
                flow.integerAdd(appended[8], one),
                appended[9],
            });

            const result = flow.enter(joined);
            return .{ .allowed = result[0], .known = result[1] };
        }

        fn upsertDocument(flow: anytype, documents: anytype, snapshot: anytype, comptime context: anytype) agent.Value(T.Documents) {
            const path = flow.productExtract(0, snapshot);
            const lookup = findDocument(flow, documents, path, context);
            const update = flow.block(.segment, .{ T.Documents, u32, T.DocumentSnapshot });
            const insert = flow.block(.segment, .{ T.Documents, T.DocumentSnapshot });
            const reject = flow.block(.terminal_handoff, .{});
            const append = flow.block(.segment, .{ T.Documents, T.DocumentSnapshot });
            const joined = flow.block(.segment, .{T.Documents});
            flow.branch(lookup.found, update, .{ documents, lookup.index, snapshot }, insert, .{ documents, snapshot });

            const updated = flow.enter(update);
            flow.jump(joined, .{flow.vectorSet(updated[0], updated[1], updated[2])});

            const inserted = flow.enter(insert);
            flow.branch(
                flow.integerGreaterEqual(
                    flow.vectorLength(inserted[0]),
                    flow.constant(u32, context.maximum_documents_index),
                ),
                reject,
                .{},
                append,
                inserted,
            );
            _ = flow.enter(reject);
            flow.failValue(flow.constant(T.Failure, context.capacity_exceeded_index));
            const appended = flow.enter(append);
            flow.jump(joined, .{flow.vectorPush(appended[0], appended[1])});
            return flow.enter(joined)[0];
        }

        fn observeTest(flow: anytype, memory: anytype, result: anytype, comptime context: anytype) agent.Value(T.Memory) {
            const mutation_count = flow.productExtract(8, memory);
            const is_baseline = flow.compareEqZero(mutation_count);
            return flow.productConstruct(T.Memory, .{
                flow.productExtract(0, memory),
                flow.productExtract(1, memory),
                flow.productExtract(2, memory),
                flow.optionalSome(?T.TestResult, result),
                flow.productExtract(4, memory),
                flow.productExtract(5, memory),
                flow.booleanOr(flow.productExtract(6, memory), is_baseline),
                flow.productExtract(1, result),
                mutation_count,
                mutation_count,
                flow.integerAdd(flow.productExtract(10, memory), flow.constant(u32, context.one_index)),
                flow.productExtract(11, memory),
            });
        }

        fn observeApplied(flow: anytype, memory: anytype, applied: anytype, comptime context: anytype) agent.Value(T.Memory) {
            const path = flow.productExtract(0, applied);
            const old_digest = flow.productExtract(1, applied);
            const new_digest = flow.productExtract(2, applied);
            const current = flow.productExtract(4, applied);
            const documents = flow.productExtract(1, memory);
            const lookup = findDocument(flow, documents, path, context);
            const reject = flow.block(.terminal_handoff, .{});
            const inspect = flow.block(.segment, .{ T.Memory, T.ReplaceApplied, u32 });
            flow.branch(lookup.found, inspect, .{ memory, applied, lookup.index }, reject, .{});
            _ = flow.enter(reject);
            flow.failValue(flow.constant(T.Failure, context.invalid_index_index));

            const values = flow.enter(inspect);
            const snapshot = flow.vectorGet(flow.productExtract(1, values[0]), values[2]);
            const valid = flow.booleanAnd(
                textEqual(flow, flow.productExtract(0, snapshot), path),
                flow.booleanAnd(
                    textEqual(flow, flow.productExtract(1, snapshot), old_digest),
                    flow.booleanAnd(
                        textEqual(flow, flow.productExtract(0, current), path),
                        textEqual(flow, flow.productExtract(1, current), new_digest),
                    ),
                ),
            );
            const admitted = flow.block(.segment, .{ T.Memory, T.ReplaceApplied });
            flow.branch(valid, admitted, .{ values[0], values[1] }, reject, .{});

            const admitted_values = flow.enter(admitted);
            const summary = flow.productConstruct(T.MutationSummary, .{
                path,
                old_digest,
                new_digest,
                flow.productExtract(3, admitted_values[1]),
            });
            const mutations = flow.productExtract(5, admitted_values[0]);
            const mutation_length = flow.vectorLength(mutations);
            const has_mutation = flow.booleanNot(flow.compareEqZero(mutation_length));
            const inspect_latest = flow.block(.segment, .{ T.Memory, T.MutationSummary, T.Mutations, u32 });
            const new_mutation = flow.block(.segment, .{ T.Memory, T.MutationSummary, T.Mutations });
            const duplicate = flow.block(.segment, .{ T.Memory, T.MutationSummary });
            const joined = flow.block(.segment, .{T.Memory});
            flow.branch(
                has_mutation,
                inspect_latest,
                .{ admitted_values[0], summary, mutations, mutation_length },
                new_mutation,
                .{ admitted_values[0], summary, mutations },
            );

            const latest_values = flow.enter(inspect_latest);
            const latest = flow.vectorGet(
                latest_values[2],
                flow.integerSubtract(latest_values[3], flow.constant(u32, context.one_index)),
            );
            const same_transition = flow.booleanAnd(
                textEqual(flow, flow.productExtract(0, latest), flow.productExtract(0, latest_values[1])),
                flow.booleanAnd(
                    textEqual(flow, flow.productExtract(1, latest), flow.productExtract(1, latest_values[1])),
                    textEqual(flow, flow.productExtract(2, latest), flow.productExtract(2, latest_values[1])),
                ),
            );
            flow.branch(
                same_transition,
                duplicate,
                .{ latest_values[0], latest_values[1] },
                new_mutation,
                .{ latest_values[0], latest_values[1], latest_values[2] },
            );

            const duplicate_values = flow.enter(duplicate);
            flow.jump(joined, .{flow.productConstruct(T.Memory, .{
                flow.productExtract(0, duplicate_values[0]),
                flow.vectorSet(
                    flow.productExtract(1, duplicate_values[0]),
                    lookup.index,
                    current,
                ),
                flow.productExtract(2, duplicate_values[0]),
                flow.productExtract(3, duplicate_values[0]),
                flow.optionalSome(
                    ?T.ReplaceSummary,
                    flow.sumConstruct(T.ReplaceSummary, 0, duplicate_values[1]),
                ),
                flow.productExtract(5, duplicate_values[0]),
                flow.productExtract(6, duplicate_values[0]),
                flow.productExtract(7, duplicate_values[0]),
                flow.productExtract(8, duplicate_values[0]),
                flow.productExtract(9, duplicate_values[0]),
                flow.productExtract(10, duplicate_values[0]),
                flow.productExtract(11, duplicate_values[0]),
            })});

            const new_values = flow.enter(new_mutation);
            const operation_full = flow.integerGreaterEqual(
                flow.vectorLength(new_values[2]),
                flow.constant(u32, context.maximum_mutations_index),
            );
            const capacity_rejected = flow.block(.terminal_handoff, .{});
            const apply = flow.block(.segment, .{ T.Memory, T.MutationSummary, T.Mutations });
            flow.branch(
                operation_full,
                capacity_rejected,
                .{},
                apply,
                new_values,
            );
            _ = flow.enter(capacity_rejected);
            flow.failValue(flow.constant(T.Failure, context.capacity_exceeded_index));

            const apply_values = flow.enter(apply);
            flow.jump(joined, .{flow.productConstruct(T.Memory, .{
                flow.productExtract(0, apply_values[0]),
                flow.vectorSet(
                    flow.productExtract(1, apply_values[0]),
                    lookup.index,
                    current,
                ),
                flow.productExtract(2, apply_values[0]),
                flow.productExtract(3, apply_values[0]),
                flow.optionalSome(
                    ?T.ReplaceSummary,
                    flow.sumConstruct(T.ReplaceSummary, 0, apply_values[1]),
                ),
                flow.vectorPush(apply_values[2], apply_values[1]),
                flow.productExtract(6, apply_values[0]),
                flow.constant(bool, context.false_index),
                flow.integerAdd(flow.productExtract(8, apply_values[0]), flow.constant(u32, context.one_index)),
                flow.productExtract(9, apply_values[0]),
                flow.productExtract(10, apply_values[0]),
                flow.productExtract(11, apply_values[0]),
            })});
            return flow.enter(joined)[0];
        }

        fn observeReplacement(flow: anytype, memory: anytype, outcome: anytype, comptime context: anytype) agent.Value(T.Memory) {
            const applied = flow.block(.segment, .{ T.Memory, T.ReplaceOutcome });
            const classify_denied = flow.block(.segment, .{ T.Memory, T.ReplaceOutcome });
            const denied = flow.block(.segment, .{ T.Memory, T.ReplaceOutcome });
            const conflict = flow.block(.segment, .{ T.Memory, T.ReplaceOutcome });
            const joined = flow.block(.segment, .{T.Memory});
            flow.branch(flow.sumTagIs(0, outcome), applied, .{ memory, outcome }, classify_denied, .{ memory, outcome });

            const applied_values = flow.enter(applied);
            flow.jump(joined, .{observeApplied(
                flow,
                applied_values[0],
                flow.sumExtract(0, applied_values[1]),
                context,
            )});

            const classified = flow.enter(classify_denied);
            flow.branch(flow.sumTagIs(1, classified[1]), denied, classified, conflict, classified);

            const denied_values = flow.enter(denied);
            flow.jump(joined, .{replaceMemoryField(
                flow,
                denied_values[0],
                4,
                flow.optionalSome(
                    ?T.ReplaceSummary,
                    flow.sumConstruct(T.ReplaceSummary, 1, flow.sumExtract(1, denied_values[1])),
                ),
            )});

            const conflict_values = flow.enter(conflict);
            flow.jump(joined, .{replaceMemoryField(
                flow,
                conflict_values[0],
                4,
                flow.optionalSome(
                    ?T.ReplaceSummary,
                    flow.sumConstruct(T.ReplaceSummary, 2, flow.sumExtract(2, conflict_values[1])),
                ),
            )});
            return flow.enter(joined)[0];
        }

        fn observeRead(flow: anytype, memory: anytype, snapshot: anytype, comptime context: anytype) agent.Value(T.Memory) {
            var next = replaceMemoryField(
                flow,
                memory,
                1,
                upsertDocument(flow, flow.productExtract(1, memory), snapshot, context),
            );
            const evidence = flow.productConstruct(T.ReadEvidence, .{
                flow.productExtract(0, snapshot),
                flow.productExtract(10, memory),
            });
            next = replaceMemoryField(flow, next, 11, evidence);
            return next;
        }

        fn observePayload(flow: anytype, memory: anytype, comptime index: u16, payload: anytype, comptime context: anytype) agent.Value(T.Memory) {
            return switch (index) {
                0 => replaceMemoryField(flow, memory, 0, flow.optionalSome(?T.ListResult, payload)),
                1 => observeRead(flow, memory, payload, context),
                2 => replaceMemoryField(flow, memory, 2, flow.optionalSome(?T.SearchResult, payload)),
                3 => observeTest(flow, memory, payload, context),
                4 => observeReplacement(flow, memory, payload, context),
                else => unreachable,
            };
        }

        pub fn emitObserveKnown(
            comptime _: type,
            comptime _: anytype,
            flow: anytype,
            memory: anytype,
            comptime observation_index: u16,
            observation: anytype,
            comptime context: anytype,
        ) agent.Value(T.Memory) {
            return observePayload(
                flow,
                memory,
                observation_index,
                flow.sumExtract(observation_index, observation),
                context,
            );
        }

        pub fn emitObservePayload(
            comptime _: type,
            comptime _: anytype,
            flow: anytype,
            memory: anytype,
            comptime observation_index: u16,
            payload: anytype,
            comptime context: anytype,
        ) agent.Value(T.Memory) {
            return observePayload(flow, memory, observation_index, payload, context);
        }

        pub fn emitObserve(
            comptime _: type,
            comptime _: anytype,
            flow: anytype,
            memory: anytype,
            observation: anytype,
            comptime context: anytype,
        ) agent.Value(T.Memory) {
            const joined = flow.block(.segment, .{T.Memory});
            var current_memory = memory;
            var current_observation = observation;
            inline for (0..5) |index| {
                if (index < 4) {
                    const selected = flow.block(.segment, .{ T.Memory, T.Observation });
                    const next = flow.block(.segment, .{ T.Memory, T.Observation });
                    flow.branch(
                        flow.sumTagIs(index, current_observation),
                        selected,
                        .{ current_memory, current_observation },
                        next,
                        .{ current_memory, current_observation },
                    );
                    const values = flow.enter(selected);
                    flow.jump(joined, .{observePayload(
                        flow,
                        values[0],
                        index,
                        flow.sumExtract(index, values[1]),
                        context,
                    )});
                    const next_values = flow.enter(next);
                    current_memory = next_values[0];
                    current_observation = next_values[1];
                } else {
                    flow.jump(joined, .{observePayload(
                        flow,
                        current_memory,
                        index,
                        flow.sumExtract(index, current_observation),
                        context,
                    )});
                }
            }
            return flow.enter(joined)[0];
        }

        pub fn emitProject(
            comptime _: type,
            comptime _: anytype,
            flow: anytype,
            memory: anytype,
        ) agent.Value(T.DecisionView) {
            const evidence = flow.productConstruct(T.DecisionEvidence, .{
                flow.productExtract(6, memory),
                flow.productExtract(7, memory),
                flow.productExtract(8, memory),
                flow.productExtract(9, memory),
                flow.productExtract(10, memory),
                flow.productExtract(11, memory),
            });
            return flow.productConstruct(T.DecisionView, .{
                flow.productExtract(0, memory),
                flow.productExtract(1, memory),
                flow.productExtract(2, memory),
                flow.productExtract(3, memory),
                flow.productExtract(4, memory),
                flow.productExtract(5, memory),
                evidence,
            });
        }

        fn replaceAllowed(flow: anytype, memory: anytype, request: anytype, comptime context: anytype) agent.Value(bool) {
            const mutation_count = flow.productExtract(8, memory);
            const tested_current = flow.integerEqual(flow.productExtract(9, memory), mutation_count);
            const below_limit = flow.booleanNot(flow.integerGreaterEqual(
                mutation_count,
                flow.constant(u32, context.maximum_mutations_index),
            ));
            const path = flow.productExtract(0, request);
            const expected_digest = flow.productExtract(1, request);
            const documents = flow.productExtract(1, memory);
            const path_admission = distinctPathAdmission(
                flow,
                flow.productExtract(5, memory),
                path,
                context,
            );
            const latest_read = flow.productExtract(11, memory);
            const revised_path_read_fresh = flow.booleanAnd(
                textEqual(flow, flow.productExtract(0, latest_read), path),
                flow.integerEqual(
                    flow.productExtract(1, latest_read),
                    flow.productExtract(10, memory),
                ),
            );
            const read_requirement_satisfied = flow.booleanOr(
                flow.booleanNot(path_admission.known),
                revised_path_read_fresh,
            );
            const lookup = findDocument(flow, documents, path, context);
            const inspect = flow.block(.segment, .{ T.Documents, u32 });
            const absent = flow.block(.segment, .{});
            const joined = flow.block(.segment, .{bool});
            flow.branch(lookup.found, inspect, .{ documents, lookup.index }, absent, .{});

            const inspected = flow.enter(inspect);
            const document = flow.vectorGet(inspected[0], inspected[1]);
            const digest_matches = textEqual(flow, flow.productExtract(1, document), expected_digest);
            flow.jump(joined, .{flow.booleanAnd(
                flow.productExtract(6, memory),
                flow.booleanAnd(
                    tested_current,
                    flow.booleanAnd(
                        below_limit,
                        flow.booleanAnd(
                            path_admission.allowed,
                            flow.booleanAnd(read_requirement_satisfied, digest_matches),
                        ),
                    ),
                ),
            )});
            _ = flow.enter(absent);
            flow.jump(joined, .{flow.constant(bool, context.false_index)});
            return flow.enter(joined)[0];
        }

        pub fn emitActionAllowed(
            comptime _: type,
            comptime _: anytype,
            flow: anytype,
            memory: anytype,
            action: anytype,
            comptime context: anytype,
        ) agent.Value(bool) {
            const replace = flow.block(.segment, .{ T.Memory, T.Action });
            const ordinary = flow.block(.segment, .{});
            const joined = flow.block(.segment, .{bool});
            flow.branch(flow.sumTagIs(4, action), replace, .{ memory, action }, ordinary, .{});
            const replace_values = flow.enter(replace);
            flow.jump(joined, .{replaceAllowed(
                flow,
                replace_values[0],
                flow.sumExtract(4, replace_values[1]),
                context,
            )});
            _ = flow.enter(ordinary);
            flow.jump(joined, .{flow.constant(bool, context.true_index)});
            return flow.enter(joined)[0];
        }

        pub fn emitActionAllowedKnown(
            comptime _: type,
            comptime _: anytype,
            flow: anytype,
            memory: anytype,
            comptime action_index: u16,
            action: anytype,
            comptime context: anytype,
        ) agent.Value(bool) {
            if (action_index == 4) {
                return replaceAllowed(
                    flow,
                    memory,
                    flow.sumExtract(4, action),
                    context,
                );
            }
            return flow.constant(bool, context.true_index);
        }

        pub fn actionAlwaysAllowedKnown(
            comptime _: type,
            comptime _: anytype,
            comptime action_index: u16,
        ) bool {
            return action_index != 4;
        }

        fn mutationPathsEqual(flow: anytype, mutations: anytype, actual: anytype, comptime context: anytype) agent.Value(bool) {
            const State = .{
                T.Mutations,
                T.ChangedFiles,
                T.Path,
                T.Path,
                T.Path,
                T.Path,
                u32,
                u32,
                u32,
                u32,
            };
            const Step = State ++ .{T.Path};
            const header = flow.block(.loop_header, State);
            const inspect = flow.block(.segment, State);
            const check_new = flow.block(.segment, Step);
            const append = flow.block(.segment, Step);
            const complete = flow.block(.segment, .{ u32, u32 });
            const mismatch = flow.block(.segment, .{});
            const joined = flow.block(.segment, .{bool});
            const empty = flow.constant(T.Path, context.empty_path_index);
            flow.jump(header, .{
                mutations,
                actual,
                empty,
                empty,
                empty,
                empty,
                flow.constant(u32, context.zero_index),
                flow.constant(u32, context.zero_index),
                flow.vectorLength(mutations),
                flow.vectorLength(actual),
            });

            const values = flow.enter(header);
            flow.branch(
                flow.integerGreaterEqual(values[7], values[8]),
                complete,
                .{ values[6], values[9] },
                inspect,
                values,
            );

            const inspected = flow.enter(inspect);
            const path = flow.productExtract(
                0,
                flow.vectorGet(inspected[0], inspected[7]),
            );
            const one = flow.constant(u32, context.one_index);
            const two = flow.constant(u32, context.two_index);
            const three = flow.constant(u32, context.three_index);
            const found = flow.booleanOr(
                flow.booleanAnd(
                    flow.integerGreaterEqual(inspected[6], one),
                    textEqual(flow, path, inspected[2]),
                ),
                flow.booleanOr(
                    flow.booleanAnd(
                        flow.integerGreaterEqual(inspected[6], two),
                        textEqual(flow, path, inspected[3]),
                    ),
                    flow.booleanOr(
                        flow.booleanAnd(
                            flow.integerGreaterEqual(inspected[6], three),
                            textEqual(flow, path, inspected[4]),
                        ),
                        flow.booleanAnd(
                            flow.integerGreaterEqual(
                                inspected[6],
                                flow.constant(u32, context.maximum_changed_files_index),
                            ),
                            textEqual(flow, path, inspected[5]),
                        ),
                    ),
                ),
            );
            flow.branch(
                found,
                header,
                .{
                    inspected[0],
                    inspected[1],
                    inspected[2],
                    inspected[3],
                    inspected[4],
                    inspected[5],
                    inspected[6],
                    flow.integerAdd(inspected[7], one),
                    inspected[8],
                    inspected[9],
                },
                check_new,
                .{
                    inspected[0],
                    inspected[1],
                    inspected[2],
                    inspected[3],
                    inspected[4],
                    inspected[5],
                    inspected[6],
                    inspected[7],
                    inspected[8],
                    inspected[9],
                    path,
                },
            );

            const checked = flow.enter(check_new);
            const has_expected = flow.booleanNot(flow.integerGreaterEqual(checked[6], checked[9]));
            const inspect_expected = flow.block(.segment, Step);
            flow.branch(has_expected, inspect_expected, checked, mismatch, .{});
            const expected_values = flow.enter(inspect_expected);
            flow.branch(
                textEqual(
                    flow,
                    expected_values[10],
                    flow.vectorGet(expected_values[1], expected_values[6]),
                ),
                append,
                expected_values,
                mismatch,
                .{},
            );

            const appended = flow.enter(append);
            flow.jump(header, .{
                appended[0],
                appended[1],
                flow.select(flow.compareEqZero(appended[6]), appended[10], appended[2]),
                flow.select(flow.integerEqual(appended[6], one), appended[10], appended[3]),
                flow.select(flow.integerEqual(appended[6], two), appended[10], appended[4]),
                flow.select(flow.integerEqual(appended[6], three), appended[10], appended[5]),
                flow.integerAdd(appended[6], one),
                flow.integerAdd(appended[7], one),
                appended[8],
                appended[9],
            });

            const complete_values = flow.enter(complete);
            flow.jump(joined, .{flow.integerEqual(complete_values[0], complete_values[1])});
            _ = flow.enter(mismatch);
            flow.jump(joined, .{flow.constant(bool, context.false_index)});
            return flow.enter(joined)[0];
        }

        pub fn emitFinalAllowed(
            comptime _: type,
            comptime _: anytype,
            flow: anytype,
            memory: anytype,
            result: anytype,
            comptime context: anytype,
        ) agent.Value(bool) {
            const mutation_count = flow.productExtract(8, memory);
            const nonzero_mutations = flow.booleanNot(flow.compareEqZero(mutation_count));
            const fresh_test = flow.integerEqual(flow.productExtract(9, memory), mutation_count);
            const count_matches = flow.integerEqual(flow.productExtract(3, result), mutation_count);
            const paths_match = mutationPathsEqual(
                flow,
                flow.productExtract(5, memory),
                flow.productExtract(1, result),
                context,
            );
            return flow.booleanAnd(
                nonzero_mutations,
                flow.booleanAnd(
                    flow.productExtract(7, memory),
                    flow.booleanAnd(
                        fresh_test,
                        flow.booleanAnd(
                            count_matches,
                            flow.booleanAnd(flow.productExtract(2, result), paths_match),
                        ),
                    ),
                ),
            );
        }
    };
}
