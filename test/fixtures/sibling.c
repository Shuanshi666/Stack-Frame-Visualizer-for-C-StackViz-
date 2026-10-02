/*
 * Two calls of the same function on ONE source line.  gdb can enter both
 * inside a single step, which used to merge the two activations into one node.
 * pair(4) has 9 invocations, plus main => 10 call events.
 */
#include <stdio.h>

static int pair(int n)
{
    if (n < 2)
    {
        return n;
    }
    return pair(n - 1) + pair(n - 2);
}

int main(void)
{
    printf("%d\n", pair(4));
    return 0;
}
