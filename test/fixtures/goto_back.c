/*
 * Adversarial: a backwards goto jumps back to a line near the top of the
 * function without any return happening.  Expected: main + add_pair +
 * sum_until(5) + sum_until(1) = 4 call events.
 */
#include <stdio.h>

static int sum_until(int n)
{
    int total = 0;
again:
    if (n <= 0)
    {
        return total;
    }
    total = total + n;
    n = n - 1;
    goto again;
}

static int add_pair(int n)
{
    return sum_until(n) + sum_until(1);
}

int main(void)
{
    printf("%d\n", add_pair(5));
    return 0;
}
