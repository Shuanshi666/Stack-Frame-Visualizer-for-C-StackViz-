/* deep stack: down(40) reaches 42 frames and 42 call events */
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
    printf("%d\n", down(40));
    return 0;
}
