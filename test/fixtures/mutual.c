/* mutual recursion: is_even(8) -> is_odd(7) -> ... = 19 calls */
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
    printf("%d %d\n", is_even(8), is_odd(8));
    return 0;
}
