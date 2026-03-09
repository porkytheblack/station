export interface CliArgs {
  port?: number;
  host?: string;
  dir?: string;
  noOpen?: boolean;
  noRunners?: boolean;
  config?: string;
  subcommand?: string;
  help?: boolean;
}

const FLAGS_WITH_VALUE = new Set(["--port", "--host", "--dir", "--config"]);

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      i++;
      continue;
    }

    if (arg === "--no-open") {
      args.noOpen = true;
      i++;
      continue;
    }

    if (arg === "--no-runners" || arg === "--read-only") {
      args.noRunners = true;
      i++;
      continue;
    }

    if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }

      switch (arg) {
        case "--port": {
          const n = parseInt(value, 10);
          if (isNaN(n) || n < 1 || n > 65535) {
            throw new Error(`Invalid port: ${value}`);
          }
          args.port = n;
          break;
        }
        case "--host":
          args.host = value;
          break;
        case "--dir":
          args.dir = value;
          break;
        case "--config":
          args.config = value;
          break;
      }

      i += 2;
      continue;
    }

    // First positional arg that doesn't start with -- is a subcommand
    if (!arg.startsWith("-")) {
      args.subcommand = arg;
      i++;
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }

  return args;
}

export function printUsage(): void {
  console.log(`
Usage: station [command] [options]

Commands:
  deploy          Generate deployment files (Dockerfile, nixpacks.toml)

Options:
  --port <n>      Override server port (default: 4400)
  --host <s>      Override server host (default: localhost)
  --dir <path>    Set station directory for generated files (default: .station)
  --config <path> Path to config file (default: station.config.ts)
  --no-open       Don't open browser on start
  --no-runners    Don't execute signal/broadcast runners (read-only mode)
  --read-only     Alias for --no-runners
  -h, --help      Show this help message
`.trim());
}
