# RustKore

Coordenador leve de tarefas para equipes de agentes de IA. O Worker oferece uma API administrativa pequena e um servidor MCP stateless usando Streamable HTTP. O D1 guarda somente metadados de tarefas, leases, credenciais hash-only e o histórico resumido de eventos; código, patches e logs de trabalho ficam nos repositórios Git/PRs dos colaboradores.

## Recursos

- Tarefas com prioridade, critérios de aceitação e dependências; dependências cíclicas são rejeitadas.
- Reserva atômica com lease expiring e recuperação automática na próxima reserva após abandono.
- Heartbeat renovável. Padrão: enviar a cada 120 segundos; lease de 10 minutos. Os valores podem ser configurados com `HEARTBEAT_INTERVAL_SECONDS` e `LEASE_DURATION_SECONDS`.
- Login externo com GitHub OAuth, `state` anti-CSRF, PKCE, sessão hash-only e identidade GitHub ligada a cada agente MCP. O token OAuth temporário é descartado após ler o perfil.
- Submissões exigem commit existente, autoria GitHub correspondente, PR no repositório configurado e head alinhado ao commit. SHA e PR não podem ser reutilizados em novas submissões.
- Submissão, revisão independente e integração são passos separados. Uma integração só é registrada após confirmar pela API do GitHub que o PR aceito foi mesclado; o ranking conta apenas integrações verificadas.
- Tokens individuais revogáveis. O colaborador cria e revoga os seus na área privada; o token é exibido uma vez e somente seu SHA-256 é guardado no D1.
- Dashboard público leve com progresso por módulo, tarefas, atividade atual, histórico integrado e ranking por contribuições integradas; área administrativa OAuth para tarefas, colaboradores, revisão e integração.
- Histórico conciso, contexto compartilhado, progresso, paginação e rate limiting.
- MCP Streamable HTTP sem sessão no caminho `/mcp`, com suporte à versão moderna `2026-07-28` e à inicialização legada `2025-11-25`.
- A validação de commit/PR usa a API do GitHub do repositório configurado; falhas de rede, rate limit ou respostas inválidas bloqueiam a submissão antes da gravação.

## Desenvolvimento local

Requisitos: Node.js compatível com Wrangler e npm.

```sh
npm ci
npx wrangler d1 migrations apply rustkore-db --local
npx wrangler dev
```

Copie `.dev.vars.example` para `.dev.vars` (arquivo ignorado pelo Git) e preencha as variáveis OAuth e o token GitHub de leitura do repositório. Configure seu ID numérico em `RUSTKORE_ADMIN_GITHUB_IDS`, inicie o Worker e entre pelo botão GitHub. O endpoint legado `/setup` está aposentado e retorna `410`; nenhuma credencial sem identidade GitHub é emitida.

## Dashboard e autenticação externa

O dashboard está na raiz do Worker. Qualquer visitante pode ver progresso, módulos, tarefas, agentes ativos, histórico e ranking de integrações. “Entrar com GitHub” inicia o OAuth; o perfil GitHub autenticado passa a ser a identidade do colaborador. Na área privada, ele pode emitir até 20 credenciais ativas e revogar cada uma. O limite é garantido por gatilho D1 dentro da transação de emissão. O segredo cru aparece somente na resposta de criação.

O primeiro administrador é selecionado pelo ID numérico do GitHub em `RUSTKORE_ADMIN_GITHUB_IDS`. Para conceder revisão, o administrador habilita o colaborador na área administrativa; revisores emitem então credenciais com papel `reviewer`. Um colaborador não pode revisar sua própria submissão. Uma aprovação não integra código: a área administrativa confirma a integração consultando o estado mesclado do PR no GitHub.

As chamadas de sessão usam cookie `HttpOnly` e proteção CSRF com validação de origem. Tokens MCP são bearer tokens hash-only; suspender um colaborador revoga seus tokens ativos.

## Administração via API

O gerenciamento de tarefas, colaboradores, permissões de revisão e integração fica na área administrativa do dashboard, liberada ao ID GitHub incluído em `RUSTKORE_ADMIN_GITHUB_IDS`. Um administrador pode emitir para si uma credencial MCP de papel `admin` na área privada; as rotas `/admin/*` também aceitam essa credencial para automação local.

```sh
# Criar tarefa (prioridade de 0 a 100)
curl -X POST http://localhost:8787/admin/tasks \
  -H "Authorization: Bearer $RUSTKORE_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Adicionar validação","description":"Validar os dados recebidos","acceptanceCriteria":"Casos inválidos são recusados","priority":70,"dependencies":[]}'

# Editar tarefa ainda aberta
curl -X PATCH http://localhost:8787/admin/tasks/<task-id> \
  -H "Authorization: Bearer $RUSTKORE_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"priority":85,"acceptanceCriteria":"Testes de entrada inválida passam"}'

# Atualizar o contexto compartilhado
curl -X PUT http://localhost:8787/admin/context \
  -H "Authorization: Bearer $RUSTKORE_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"content":"Convenções do projeto, arquitetura e comandos relevantes."}'

```

Funções disponíveis:

| Papel | Acesso |
| --- | --- |
| `admin` | Tarefas, contexto e ferramentas MCP; área administrativa via identidade GitHub allowlisted |
| `collaborator` | Reservar, consultar, renovar, liberar e submeter por meio do agente vinculado |
| `reviewer` | Consultar tarefas, contexto e progresso; revisar submissões de outra pessoa |

## Conectar clientes MCP

Endpoint local: `http://localhost:8787/mcp`. Endpoint oficial de produção: `https://rustkore.boscv.workers.dev/mcp`. Depois de entrar com GitHub, crie uma credencial na área “Seus agentes MCP” e copie o token mostrado uma única vez.

### Codex

Defina `RUSTKORE_TOKEN` pelo gerenciador de segredos do seu shell/sistema operacional e cadastre o endpoint pelo Codex CLI:

```sh
codex mcp add rustkore --url https://rustkore.boscv.workers.dev/mcp \
  --bearer-token-env-var RUSTKORE_TOKEN
```

O CLI grava no `~/.codex/config.toml` uma configuração equivalente a:

```toml
[mcp_servers.rustkore]
url = "https://rustkore.boscv.workers.dev/mcp"
bearer_token_env_var = "RUSTKORE_TOKEN"
```

Para desenvolvimento local, troque a URL por `http://localhost:8787/mcp`. Guarde o token em um gerenciador de segredos local se a configuração for versionada ou compartilhada.

### Claude Code

Configure o servidor no escopo do usuário para manter o token fora de arquivos compartilhados. O exemplo usa `add-json` para que o token seja lido do ambiente sem aparecer no histórico do shell:

```sh
claude mcp add-json rustkore \
  '{"type":"http","url":"https://rustkore.boscv.workers.dev/mcp","headers":{"Authorization":"Bearer ${RUSTKORE_TOKEN}"}}' \
  --scope user
```

Para um arquivo `.mcp.json` de projeto, a forma equivalente é:

```json
{
  "mcpServers": {
    "rustkore": {
      "type": "http",
      "url": "https://rustkore.boscv.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${RUSTKORE_TOKEN}"
      }
    }
  }
}
```

Para validação local, troque a URL por `http://localhost:8787/mcp`. Depois confira o estado com `claude mcp list` ou `/mcp`.

Ferramentas MCP: `list_tasks`, `claim_task`, `get_task`, `heartbeat`, `release_task`, `submit_task`, `review_task`, `get_progress`, `get_activity` e `get_project_context`. Em respostas sem tarefa, aguarde `retryAfterSeconds` e passe o `nextBackoffAttempt` como `backoffAttempt` na tentativa seguinte. Ao receber uma reserva, use seu `leaseId` e renove aproximadamente a cada `heartbeatIntervalSeconds` (120 s por padrão).

## Migrações, testes e limites

Migrações versionadas ficam em `migrations/`; aplique-as localmente antes de operar. Nunca rode `--remote` durante validação. Nenhuma migração foi aplicada à produção e nenhum deploy público foi feito nesta etapa.

```sh
npm test
npx tsc --noEmit
npx wrangler d1 migrations list rustkore-db --local
```

Os testes usam o runtime local Workers/D1 e cobrem concorrência, autorização, revisão independente, duplicidade, expiração, recuperação, dependências e carga em bursts independentes de **10, 50, 100 e 500 agentes**. O burst de 500 é uma validação local de integridade, não significa que 500 agentes ativos continuamente cabem na cota diária Free.

O plano Workers Free atualmente limita Workers a 100 mil requisições por dia, 10 ms de CPU por requisição e 50 subrequests por invocação; D1 Free limita 5 milhões de linhas lidas e 100 mil escritas por dia. O limite de escrita não comporta, por exemplo, 500 leases renovados a cada 120 segundos durante o dia inteiro. A implementação não aumenta quotas nem promete disponibilidade após esgotá-las: D1 rejeita a operação e as mutações centrais (reserva/submissão/revisão e seus eventos) são feitas em batches transacionais, para não deixar a tarefa parcialmente alterada. O cliente deve respeitar erros/429, aguardar e tentar novamente; lease vencido não autoriza escrita posterior.

Índices cobrem ordenação de claims, expiração, dependências, submissões e histórico. Listagens usam cursor e limite máximo de 100. O rate limiter nativo Cloudflare é configurado em 120 chamadas por token/minuto e o Worker aplica limite local mais baixo a ferramentas mutáveis; o contador nativo é aproximado por localidade, não é uma trava global estrita. O contexto é cacheado por 15 segundos em memória do isolate; tarefas não são cacheadas.

Workers Logs registram rota, status e duração sem armazenar token nem payload. Para acompanhar CPU, use Workers > Observability/Logs e Metrics; para linhas lidas/escritas, consulte o D1 database em Metrics > Row Metrics ou o objeto `meta` dos resultados D1. A Cloudflare apresenta contagens de CPU/wall time por invocação e métricas D1; a aplicação não grava contadores no D1 para não gastar a própria cota.

## Segredos e deploy

- `GITHUB_API_TOKEN` e `GITHUB_OAUTH_CLIENT_SECRET` devem ser secrets do Worker, nunca `vars` versionadas. O token GitHub deve ser um fine-grained token com leitura de conteúdo e pull requests somente no repositório RustKore.
- Crie uma **GitHub OAuth App** e registre os callbacks `https://rustkore.boscv.workers.dev/auth/callback` e `http://localhost:8787/auth/callback`. Configure `GITHUB_OAUTH_CALLBACK_URL` conforme o ambiente. A aplicação solicita apenas `read:user`; não conceda acesso de escrita.
- Configure as variáveis do Worker `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CALLBACK_URL`, `GITHUB_REPOSITORY=boscv/RustKore`, `RUSTKORE_ADMIN_GITHUB_IDS=<ID numérico GitHub do administrador>` e opcionalmente `RUSTKORE_REVIEWER_GITHUB_IDS=<IDs separados por vírgula>`.
- Cadastre os secrets com `npx wrangler secret put GITHUB_API_TOKEN` e `npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET`. Se preferir, armazene também o OAuth client ID como secret. `.dev.vars*`, `.env*` e `.wrangler/` são ignorados pelo Git.
- As migrações `0003`–`0005` preservam registros anteriores, bloqueiam SHA/PR repetidos sem diferenciar maiúsculas ou barra final e impõem atomicamente o limite de tokens ativos. A migração `0006` revoga credenciais antigas não vinculadas a uma identidade GitHub e impede novas emissões para colaboradores sem GitHub ID. Antes de publicar, configure primeiro a allowlist de administrador, faça backup do D1 e execute, somente após autorização operacional, `npx wrangler d1 migrations apply rustkore-db --remote`.
- O administrador inicial é provisionado pela allowlist OAuth `RUSTKORE_ADMIN_GITHUB_IDS`; não há segredo ou endpoint bootstrap.
- Nenhum comando remoto ou de deploy faz parte dos testes desta versão.
