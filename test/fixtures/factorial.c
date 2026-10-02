/* linear recursion: main + factorial(4..1) + sum_to(3..0) = 9 calls */
#include <stdio.h>

static int factorial(int n)
{
    if (n <= 1)
    {
        return 1;
    }
    return n * factorial(n - 1);
}

static int sum_to(int n)
{
    if (n <= 0)
    {
        return 0;
    }
    return n + sum_to(n - 1);
}

int main(void)
{
    int n = 4;
    printf("factorial(%d) = %d\n", n, factorial(n));
    printf("sum_to(3) = %d\n", sum_to(3));
    return 0;
}
