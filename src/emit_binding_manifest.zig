const std = @import("std");
const boundary = @import("boundary");
const world = @import("world");
const application = @import("praxis_application");

const App = application.Application;
const Compiled = application.Compiled;

fn findEffect(interface_label: []const u8) !@TypeOf(App.Manifest.residual_effects[0]) {
    const expected = world.protocol.v1.digestLabel("world.effect-interface.v1", interface_label);
    for (App.Manifest.residual_effects) |effect| {
        if (std.mem.eql(u8, &effect.interface_id, &expected)) return effect;
    }
    return error.MissingResidualEffect;
}

fn writeInterface(
    out: *std.Io.Writer,
    operation: []const u8,
    site_identity: []const u8,
    interface_label: []const u8,
    maximum_result_bytes: u32,
    trailing: bool,
) !void {
    const effect = try findEffect(interface_label);
    const interface_id = std.fmt.bytesToHex(effect.interface_id, .lower);
    const payload_schema_id = std.fmt.bytesToHex(effect.payload_schema_id, .lower);
    const result_schema_id = std.fmt.bytesToHex(effect.result_schema_id, .lower);
    try out.print(
        "    {{\"operation\":\"{s}\",\"siteIdentity\":\"{s}\",\"interfaceLabel\":\"{s}\",\"interfaceId\":\"{s}\",\"payloadSchemaId\":\"{s}\",\"resultSchemaId\":\"{s}\",\"authorityRequirements\":\"{d}\",\"maximumResultBytes\":{d}}}{s}\n",
        .{
            operation,
            site_identity,
            interface_label,
            &interface_id,
            &payload_schema_id,
            &result_schema_id,
            effect.authority_requirements,
            maximum_result_bytes,
            if (trailing) "," else "",
        },
    );
}

fn schemaMaximum(comptime Site: type) u32 {
    return comptime @intCast(boundary.schema.maximumEncodedSize(Site.Resume));
}

pub fn main(init: std.process.Init) !void {
    var buffer: [16 * 1024]u8 = undefined;
    var writer = std.Io.File.stdout().writer(init.io, &buffer);
    const out = &writer.interface;
    const application_id = std.fmt.bytesToHex(App.Manifest.application_id, .lower);
    const contract_digest = std.fmt.bytesToHex(application.DecisionContract.canonical_digest, .lower);
    try out.print(
        "{{\n  \"format\":\"praxis-binding-manifest/v1\",\n  \"applicationId\":\"{s}\",\n  \"applicationName\":\"{s}\",\n  \"applicationVersion\":\"{s}\",\n  \"decisionContractDigest\":\"{s}\",\n  \"interfaces\":[\n",
        .{
            &application_id,
            App.Manifest.application_name,
            App.Manifest.application_version,
            &contract_digest,
        },
    );
    try writeInterface(
        out,
        "decide",
        Compiled.DecisionSite.semantic_identity,
        "model.decide.v1",
        @intCast(Compiled.Definition.decision.maximum_result_bytes),
        true,
    );
    try writeInterface(out, "list", Compiled.ActionSites[1].semantic_identity, "repo.list.v2", schemaMaximum(Compiled.ActionSites[1]), true);
    try writeInterface(out, "read", Compiled.ActionSites[2].semantic_identity, "repo.read.v2", schemaMaximum(Compiled.ActionSites[2]), true);
    try writeInterface(out, "search", Compiled.ActionSites[3].semantic_identity, "repo.search.v2", schemaMaximum(Compiled.ActionSites[3]), true);
    try writeInterface(out, "test", Compiled.ActionSites[4].semantic_identity, "repo.test.v2", schemaMaximum(Compiled.ActionSites[4]), true);
    try writeInterface(out, "replace", Compiled.ActionSites[5].semantic_identity, "repo.replace.approved.v2", schemaMaximum(Compiled.ActionSites[5]), false);
    try out.writeAll("  ]\n}\n");
    try out.flush();
}
