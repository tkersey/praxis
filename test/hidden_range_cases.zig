const std = @import("std");
const range = @import("range");

test "inclusive sum handles negative, descending, and wider ranges" {
    try std.testing.expectEqual(@as(i32, 0), range.inclusiveSum(-2, 2));
    try std.testing.expectEqual(@as(i32, 0), range.inclusiveSum(4, 2));
    try std.testing.expectEqual(@as(i32, 55), range.inclusiveSum(1, 10));
}
