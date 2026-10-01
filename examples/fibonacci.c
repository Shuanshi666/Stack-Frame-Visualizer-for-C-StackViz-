/*
 * StackViz example: tree recursion.
 *
 * fib(n) calls itself twice, so the call tree branches instead of forming a
 * single chain.  Open "StackViz: Open Visualizer" and press play to watch one
 * branch finish before the next one starts.
 */
#include <stdio.h>

static int fib(int n)
{
    if (n < 2)
    {
        return n;
    }
    return fib(n - 1) + fib(n - 2);
}

int main(void)
{
    int n = 6;
    printf("fib(%d) = %d\n", n, fib(n));
    return 0;
}
