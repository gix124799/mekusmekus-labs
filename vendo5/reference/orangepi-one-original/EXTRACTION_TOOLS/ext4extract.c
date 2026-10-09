#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/stat.h>
#include <limits.h>
#include <fcntl.h>
#include <ext2fs/ext2fs.h>

static ext2_filsys fs;
static int bad=0;
static long file_count=0;
static long long bytes=0;
typedef struct { ext2_ino_t ino; char name[256]; } entry_t;
typedef struct { entry_t *items;size_t n,cap; } entries_t;
static int dircb(ext2_ino_t dir,int idx,struct ext2_dir_entry *de,int off,int size,char *buf,void *ctx){
 (void)dir;(void)idx;(void)off;(void)size;(void)buf;
 if(!de->inode)return 0;
 int len=ext2fs_dirent_name_len(de);
 if(len<1||len>255)return 0;
 if((len==1&&de->name[0]=='.')||(len==2&&de->name[0]=='.'&&de->name[1]=='.'))return 0;
 entries_t *es=(entries_t*)ctx;
 if(es->n==es->cap){es->cap=es->cap?es->cap*2:32;es->items=realloc(es->items,es->cap*sizeof(entry_t));if(!es->items){fprintf(stderr,"OOM\n");exit(2);}}
 entry_t *e=&es->items[es->n++];e->ino=de->inode;memcpy(e->name,de->name,len);e->name[len]='\0';return 0;
}
static int mkdirs(const char *path){
 char tmp[PATH_MAX];snprintf(tmp,sizeof(tmp),"%s",path);for(char *p=tmp+1;*p;p++)if(*p=='/'){*p=0;if(mkdir(tmp,0755)&&errno!=EEXIST)return -1;*p='/';}
 return 0;
}
static int extract_file(ext2_ino_t ino, const char *target, unsigned int mode) {
 ext2_file_t file;errcode_t rc=ext2fs_file_open(fs,ino,0,&file);
 if(rc){fprintf(stderr,"ERR file_open %s rc=%ld\n",target,(long)rc);bad++;return -1;}
 if(mkdirs(target)){perror(target);ext2fs_file_close(file);bad++;return -1;}
 FILE *f=fopen(target,"wb");if(!f){perror(target);ext2fs_file_close(file);bad++;return -1;}
 unsigned char buf[65536];__u64 len=0;ext2fs_file_get_lsize(file,&len);
 for(__u64 done=0;done<len;){unsigned int got=0;int want=(len-done)>sizeof(buf)?sizeof(buf):len-done;rc=ext2fs_file_read(file,buf,want,&got);
  if(rc||!got){fprintf(stderr,"ERR read %s len=%llu at=%llu rc=%ld\n",target,(unsigned long long)len,(unsigned long long)done,(long)rc);bad++;break;}
  if(fwrite(buf,1,got,f)!=got){perror("write");bad++;break;}
  done+=got;
 }
 fclose(f);ext2fs_file_close(file);chmod(target,mode&0777);file_count++;bytes+=len;
 return 0;
}
static int recurse(ext2_ino_t ino,const char *guest,const char *target,int depth,int extract,int print){
 struct ext2_inode in;errcode_t rc=ext2fs_read_inode(fs,ino,&in);
 if(rc){fprintf(stderr,"read inode %s rc %ld\n",guest,(long)rc);bad++;return -1;}
 if(S_ISREG(in.i_mode)){
  __u64 size= EXT2_I_SIZE(&in);
  if(print)printf("F %llu %s\n",(unsigned long long)size,guest);
  if(extract)extract_file(ino,target,in.i_mode);return 0;
 }
 if(S_ISLNK(in.i_mode)){
  if(print)printf("L %u %s\n",in.i_size,guest);
  if(extract){char linkbuf[4096]={0};if(in.i_size>=sizeof(linkbuf)){bad++;return -1;}
    if(ext2fs_is_fast_symlink(&in))memcpy(linkbuf,in.i_block,in.i_size);
    else{ext2_file_t file;if(!ext2fs_file_open(fs,ino,0,&file)){unsigned int got=0;ext2fs_file_read(file,linkbuf,in.i_size,&got);ext2fs_file_close(file);}}
    if(!mkdirs(target)){unlink(target);if(symlink(linkbuf,target))fprintf(stderr,"SYMLINK_ERROR %s %s\n",target,strerror(errno));}
  }return 0;
 }
 if(S_ISDIR(in.i_mode)){
  if(print)printf("D 0 %s\n",guest);
  if(extract){if(mkdirs(target)|| (mkdir(target,0755)&&errno!=EEXIST)){perror("mkdir");bad++;}}
  if(depth>30){bad++;return -1;}
  entries_t es={0};rc=ext2fs_dir_iterate2(fs,ino,0,NULL,dircb,&es);
  if(rc){fprintf(stderr,"read directory %s rc %ld\n",guest,(long)rc);bad++;}
  for(size_t i=0;i<es.n;i++){
   char g[PATH_MAX],t[PATH_MAX];
   snprintf(g,sizeof(g),"%s%s%s",guest,strcmp(guest,"/")==0?"":"/",es.items[i].name);
   snprintf(t,sizeof(t),"%s/%s",target,es.items[i].name);
   recurse(es.items[i].ino,g,t,depth+1,extract,print);
  }
  free(es.items);return 0;
 }
 if(print)printf("X 0 %s\n",guest);
 return 0;
}
int main(int argc,char **argv){
 if(argc<4){fprintf(stderr,"Usage: ext4extract image [list|extract] /guestpath [dest]\n");return 2;}
 int extract=strcmp(argv[2],"extract")==0;
 if(extract&&argc<5){fprintf(stderr,"missing dest\n");return 2;}
 errcode_t rc=ext2fs_open(argv[1],EXT2_FLAG_SOFTSUPP_FEATURES|EXT2_FLAG_64BITS|EXT2_FLAG_IGNORE_CSUM_ERRORS,0,0,unix_io_manager,&fs);
 if(rc){fprintf(stderr,"ext2fs_open rc=%ld\n",(long)rc);return 2;}
 ext2_ino_t ino=0;rc=ext2fs_namei(fs,EXT2_ROOT_INO,EXT2_ROOT_INO,argv[3],&ino);
 if(rc){fprintf(stderr,"ext2fs_namei %s rc=%ld\n",argv[3],(long)rc);return 3;}
 int ret=recurse(ino,argv[3],extract?argv[4]:"",0,extract,!extract);
 fprintf(stderr,"DONE files=%ld bytes=%lld failures=%d\n",file_count,bytes,bad);
 ext2fs_close(fs);return ret||bad?1:0;
}
