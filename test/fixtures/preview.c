/* variable preview: ints, doubles, arrays, strings, pointers and a struct */
#include <stdio.h>

typedef struct Point
{
    int x;
    int y;
    char label[8];
} Point;

static int sum(const int *values, int count, int i)
{
    if (i >= count)
    {
        return 0;
    }
    return values[i] + sum(values, count, i + 1);
}

int main(void)
{
    int values[12];
    for (int i = 0; i < 12; i++)
    {
        values[i] = i * i;
    }
    int *ptr = values;
    Point p = {3, 4, "hi"};
    char text[150];
    for (int i = 0; i < 149; i++)
    {
        text[i] = 'a' + (i % 26);
    }
    text[149] = '\0';
    double ratio = 1.5;
    int total = sum(values, 12, 0);
    printf("%d %p %d %d %s %f\n", total, (void *)ptr, p.x, p.y, text, ratio);
    return 0;
}
