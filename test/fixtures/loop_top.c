/*
 * Adversarial for the "stopped on the closing brace" signal: the loop header is
 * the first line of the function, so control jumps backwards to the entry line
 * on every iteration.  A recording that mistook that for a new activation would
 * report phantom calls.  Expected: 1 + 3 = 4 call events.
 */
#include <stdio.h>

static int countdown(int n)
{
    while (n > 0)
    {
        n = n - 1;
    }
    return n;
}

static int twice(int n)
{
    return countdown(n) + countdown(2);
}

int main(void)
{
    printf("%d\n", twice(3));
    return 0;
}
