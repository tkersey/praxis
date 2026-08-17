const std = @import("std");
const range = @import("range");

test "a closed range includes both endpoints and its singleton" {
    try std.testing.expectEqual(@as(i32, 9), range.sumRange(2, 4));
    try std.testing.expectEqual(@as(i32, 5), range.sumRange(5, 5));
}
