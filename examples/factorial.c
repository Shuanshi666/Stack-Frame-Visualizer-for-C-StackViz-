/*
 * StackViz example: recursion you can watch.
 *
 * Compile with the plugin compile mode (or by hand):
 *   gcc -g -O0 -fno-omit-frame-pointer -fno-optimize-sibling-calls \
 *       -o .stackviz/a.out examples/factorial.c
 *
 * Then run "StackViz: Compile and Visualize Recursion" with this file open.
 */
#include <stdio.h>

static int factorial(int n) {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

static int sum_to(int n) {
  if (n <= 0) {
    return 0;
  }
  return n + sum_to(n - 1);
}

int main(void) {
  int n = 4;
  int f = factorial(n);
  int s = sum_to(3);

  printf("factorial(%d) = %d\n", n, f);
  printf("sum_to(3) = %d\n", s);
  return 0;
}
