/**
 * Shell completion scripts, emitted by `agend completion <shell>`.
 *
 * Instance names come from `agend ls --names-only`, which shares its name list
 * with `attach`'s fuzzy resolver — so the candidates offered are exactly the
 * ones `attach` will accept.
 *
 * Both scripts complete subcommands at the first position too. A `complete -F`
 * / `compdef` registration REPLACES the shell's default completion for the
 * command, so a script that only handled `attach` would leave every other
 * position completing nothing at all — worse than no script.
 */

export const COMPLETION_SHELLS = ["bash", "zsh"] as const;
export type CompletionShell = typeof COMPLETION_SHELLS[number];

export interface CompletionSpec {
  /** Top-level subcommand names (e.g. attach, ls, fleet). */
  topLevel: string[];
  /** `fleet` subcommand names (e.g. start, stop, logs). */
  fleetSub: string[];
  /** Top-level commands whose first argument is an instance name. */
  instanceCommands: string[];
  /** `fleet` subcommands whose first argument is an instance name. */
  fleetInstanceCommands: string[];
}

/** Reject anything that could break out of the generated script's quoting. */
function words(list: string[]): string {
  const safe = list.filter(w => /^[A-Za-z0-9_-]+$/.test(w));
  return safe.join(" ");
}

export function bashCompletion(spec: CompletionSpec): string {
  return `# agend bash completion — eval "$(agend completion bash)"

# Instance names are one per line, so IFS must be newline while reading them.
# It is scoped to this helper on purpose: a function-wide IFS=$'\\n' would make
# compgen treat the space-separated subcommand lists below as a single word,
# which silently breaks subcommand completion.
_agend_complete_instances() {
  local IFS=$'\\n'
  COMPREPLY=($(compgen -W "$("$1" ls --names-only 2>/dev/null)" -- "$2"))
}

_agend_completion() {
  local cur cmd sub agend_bin
  COMPREPLY=()                      # never inherit a previous invocation's list
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"
  sub="\${COMP_WORDS[2]}"
  agend_bin="\${COMP_WORDS[0]:-agend}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${words(spec.topLevel)}" -- "$cur"))
    return
  fi

  if [ "$cmd" = "completion" ] && [ "$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=($(compgen -W "${words([...COMPLETION_SHELLS])}" -- "$cur"))
    return
  fi

  if [ "$cmd" = "fleet" ]; then
    if [ "$COMP_CWORD" -eq 2 ]; then
      COMPREPLY=($(compgen -W "${words(spec.fleetSub)}" -- "$cur"))
      return
    fi
    case " ${words(spec.fleetInstanceCommands)} " in
      *" $sub "*)
        if [ "$COMP_CWORD" -eq 3 ]; then
          _agend_complete_instances "$agend_bin" "$cur"
        fi
        ;;
    esac
    return
  fi

  case " ${words(spec.instanceCommands)} " in
    *" $cmd "*)
      if [ "$COMP_CWORD" -eq 2 ]; then
        _agend_complete_instances "$agend_bin" "$cur"
      fi
      ;;
  esac
}
complete -F _agend_completion agend
`;
}

export function zshCompletion(spec: CompletionSpec): string {
  return `# agend zsh completion — eval "$(agend completion zsh)"
# Requires compinit to have run first (put \`autoload -Uz compinit && compinit\`
# above this line in ~/.zshrc).
#
# compadd is used rather than _values/_describe because it is the lowest-level
# primitive and filters by the current prefix on its own — fewer moving parts.
_agend() {
  local -a instances
  local agend_bin="\${words[1]:-agend}"
  # \${(f)...} splits on newlines only, so a name is never split on whitespace.
  local -a lines

  if (( CURRENT == 2 )); then
    compadd -- ${words(spec.topLevel)}
    return
  fi

  if [[ "\${words[2]}" == "completion" ]] && (( CURRENT == 3 )); then
    compadd -- ${words([...COMPLETION_SHELLS])}
    return
  fi

  if [[ "\${words[2]}" == "fleet" ]]; then
    if (( CURRENT == 3 )); then
      compadd -- ${words(spec.fleetSub)}
      return
    fi
    if (( CURRENT == 4 )) && [[ " ${words(spec.fleetInstanceCommands)} " == *" \${words[3]} "* ]]; then
      instances=(\${(f)"$("$agend_bin" ls --names-only 2>/dev/null)"})
      (( \${#instances} )) && compadd -a instances
    fi
    return
  fi

  if (( CURRENT == 3 )) && [[ " ${words(spec.instanceCommands)} " == *" \${words[2]} "* ]]; then
    instances=(\${(f)"$("$agend_bin" ls --names-only 2>/dev/null)"})
    (( \${#instances} )) && compadd -a instances
  fi
}
compdef _agend agend
`;
}

export function completionScript(shell: CompletionShell, spec: CompletionSpec): string {
  return shell === "zsh" ? zshCompletion(spec) : bashCompletion(spec);
}
