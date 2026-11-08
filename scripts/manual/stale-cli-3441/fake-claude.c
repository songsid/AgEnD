/* Inert native fixture: no network or vendor CLI. Records launches and echoes input. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc,char **argv) {
  const char *resume="none",*log=getenv("RIG_LOG");
  for(int i=1;i+1<argc;i++) if(!strcmp(argv[i],"--resume"))resume=argv[i+1];
  FILE *f=fopen(log,"a");if(!f)return 2;
  fprintf(f,"START %d %s\n",getpid(),resume);fclose(f);
  setbuf(stdout,NULL);printf("Fixture Claude ready\n❯ \n");
  char line[4096];while(fgets(line,sizeof(line),stdin)){f=fopen(log,"a");if(!f)return 3;fprintf(f,"INPUT %d %s",getpid(),line);fclose(f);printf("answer: %s❯ \n",line);}
  return 0;
}
