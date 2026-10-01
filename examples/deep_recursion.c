/*
 * StackViz example: a deep call stack.
 *
 * `down` adds one to the result of the next call, so 40 levels fit in an int
 * without overflowing, and the stack really does get 42 frames deep
 * (main + down(40) ... down(0)).
 *
 * Use it with "StackViz: Compile and Visualize Recursion", or build it by hand:
 *   gcc -g -O0 -fno-omit-frame-pointer -fno-optimize-sibling-calls \
 *       -o .stackviz/a.out examples/deep_recursion.c
 */
#include <stdio.h>

static int down(int n)
{
    if (n == 0)
    {
        return 0;
    }
    return 1 + down(n - 1);
}

int main(void)
{
    int result = down(40);
    printf("down(40) = %d\n", result);
    return 0;
}
