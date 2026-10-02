/* tree recursion: fib(6) needs 26 call events (main + 25 invocations) */
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
    printf("fib(6) = %d\n", fib(6));
    return 0;
}
