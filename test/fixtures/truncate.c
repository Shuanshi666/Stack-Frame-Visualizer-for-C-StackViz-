/* used with a small maxDepth to test truncation (down(12) = 14 frames) */
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
    printf("%d\n", down(12));
    return 0;
}
