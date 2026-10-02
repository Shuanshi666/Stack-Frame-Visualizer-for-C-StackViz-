/*
 * A library function (qsort) calling back into user code: its frame is filtered
 * out, so the comparator hangs directly under its caller.
 */
#include <stdio.h>
#include <stdlib.h>

static int compare_desc(const void *left, const void *right)
{
    int a = *(const int *)left;
    int b = *(const int *)right;
    return b - a;
}

int main(void)
{
    int values[5] = {3, 1, 4, 1, 5};
    qsort(values, 5, sizeof(int), compare_desc);
    printf("%d\n", values[0]);
    return 0;
}
