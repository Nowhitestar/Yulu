#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(const char *operation, const char *path) {
    fprintf(stderr, "yulu-durable-sync: %s %s: %s\n", operation, path, strerror(errno));
    return 1;
}

#if YULU_DURABLE_SYNC_POLICY_LOG
static int append_policy_log(const char *path) {
    const char *log_path = getenv("YULU_DURABLE_SYNC_POLICY_LOG");
    if (log_path == NULL) return 0;
    if (log_path[0] != '/') {
        errno = EINVAL;
        return fail("policy log is missing or not absolute for", path);
    }
    FILE *log = fopen(log_path, "a");
    if (log == NULL) return fail("open policy log for", path);
    if (fprintf(log, "%s\n", path) < 0 || fclose(log) != 0) {
        return fail("write policy log for", path);
    }
    return 0;
}
#endif

int main(int argc, char **argv) {
    if (argc != 2 || argv[1][0] != '/') {
        fprintf(stderr, "usage: yulu-durable-sync /absolute/owned/file-or-directory\n");
        return 64;
    }

    const char *path = argv[1];
    struct stat before;
    if (lstat(path, &before) != 0) return fail("lstat", path);
    if ((!S_ISREG(before.st_mode) && !S_ISDIR(before.st_mode)) || before.st_uid != geteuid()) {
        errno = EPERM;
        return fail("reject unsafe node", path);
    }

    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return fail("open", path);
    struct stat opened;
    if (fstat(fd, &opened) != 0) {
        int saved = errno;
        close(fd);
        errno = saved;
        return fail("fstat", path);
    }
    if (before.st_dev != opened.st_dev || before.st_ino != opened.st_ino ||
        before.st_mode != opened.st_mode || before.st_uid != opened.st_uid) {
        close(fd);
        errno = ESTALE;
        return fail("detect replacement of", path);
    }
    if (fsync(fd) != 0 || fcntl(fd, F_FULLFSYNC) != 0) {
        int saved = errno;
        close(fd);
        errno = saved;
        return fail("fsync", path);
    }
    if (close(fd) != 0) return fail("close", path);

#if YULU_DURABLE_SYNC_POLICY_LOG
    return append_policy_log(path);
#else
    return 0;
#endif
}
