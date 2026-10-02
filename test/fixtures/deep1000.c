/* deep stack for the slow test: down(1000) reaches 1002 frames */
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
    printf("%d\n", down(1000));
    return 0;
}
