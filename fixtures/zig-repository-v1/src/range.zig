/// Sums the values before `end`. This legacy half-open behavior is the defect:
/// callers need an explicitly named inclusive operation.
pub fn sumRange(start: i32, end: i32) i32 {
    var total: i32 = 0;
    var current = start;
    while (current < end) : (current += 1) total += current;
    return total;
}
