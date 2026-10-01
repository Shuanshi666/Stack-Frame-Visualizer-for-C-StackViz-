/*
 * StackViz example: mutual recursion.
 *
 * is_even() and is_odd() keep handing control to each other.  In the call tree
 * you can see the two functions alternating, one frame per step down.
 */
#include <stdio.h>

static int is_odd(int n);

static int is_even(int n)
{
    if (n == 0)
    {
        return 1;
    }
    return is_odd(n - 1);
}

static int is_odd(int n)
{
    if (n == 0)
    {
        return 0;
    }
    return is_even(n - 1);
}

int main(void)
{
    int n = 8;
    printf("is_even(%d) = %d\n", n, is_even(n));
    printf("is_odd(%d)  = %d\n", n, is_odd(n));
    return 0;
}
