#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  int fd = open(argv[1], O_RDONLY | O_DIRECTORY);
  struct fsxattr attr;
  if (fd < 0 || ioctl(fd, FS_IOC_FSGETXATTR, &attr)) { perror("read project"); return 1; }
  if (!attr.fsx_projid || !(attr.fsx_xflags & FS_XFLAG_PROJINHERIT)) return 1;
  attr.fsx_projid = 0;
  attr.fsx_xflags &= ~FS_XFLAG_PROJINHERIT;
  errno = 0;
  if (ioctl(fd, FS_IOC_FSSETXATTR, &attr) != -1 || errno != EPERM) return 1;
  close(fd);
  if (argc == 2) {
    pid_t child = fork();
    if (child < 0) return 1;
    if (!child) { execl(argv[0], argv[0], argv[1], "child", NULL); _exit(1); }
    int status;
    if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status)) return 1;
  }
  puts("owned directory project mutation denied, including exec child");
  return 0;
}
