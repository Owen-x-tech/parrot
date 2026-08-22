type Props = {
  harness: "codex" | "claude";
  className?: string;
};

const labels = {
  codex: "Codex",
  claude: "Claude Code",
} as const;

export function AgentLogo({ harness, className = "" }: Props) {
  return <img className={`agent-logo ${className}`.trim()} src={`/${harness}-icon.png`} alt={`${labels[harness]} logo`} />;
}
