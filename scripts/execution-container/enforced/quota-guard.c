#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#if defined(__aarch64__)
#define EXPECTED_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define EXPECTED_ARCH AUDIT_ARCH_X86_64
#else
#error "Quota guard supports only Linux aarch64 and x86_64"
#endif
#define DENY (SECCOMP_RET_ERRNO | EPERM)
/* Stacks on the engine's default seccomp filter. Never replaces it with allow-all. */
int main(int argc, char **argv) {
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, EXPECTED_ARCH, 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, 0x40000000, 0, 1), /* no x32 ABI bypass */
    BPF_STMT(BPF_RET|BPF_K, DENY),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 469, 0, 1), /* file_setattr on supported 64-bit ABIs */
    BPF_STMT(BPF_RET|BPF_K, DENY),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_ioctl, 0, 5),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_STMT(BPF_ALU|BPF_AND|BPF_K, 0xffff),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 0x5820, 1, 0), /* FS_IOC_FSSETXATTR */
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 0x6602, 0, 1), /* FS_IOC_SETFLAGS, all encoded sizes */
    BPF_STMT(BPF_RET|BPF_K, DENY),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(rules)/sizeof(rules[0]), .filter = rules };
  if (prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0) || prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program)) { perror("quota guard"); return 126; }
  if (argc==2 && !strcmp(argv[1],"--self-test")) {
    errno=0; if (ioctl(-1,0x401c5820,NULL)!=-1 || errno!=EPERM) return 1;
    errno=0; if (ioctl(-1,0x40086602,NULL)!=-1 || errno!=EPERM) return 1;
    errno=0; if (syscall(469,-1,NULL,0,0)!=-1 || errno!=EPERM) return 1;
    puts("quota mutation syscalls denied"); return 0;
  }
  if (argc<2) return 2;
  execvp(argv[1],argv+1); perror("quota guard exec"); return 127;
}
