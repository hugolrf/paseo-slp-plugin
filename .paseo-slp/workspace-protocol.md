---
version: '15'
owner: 'Hugo (fork owner; historical decisions retained below)'
applies_to: 'paseo-slp source repository'
last_reviewed: '2026-11-01'
package_version: '0.4.0'
template_sha256: 'c5b6db392e3d9646d931cda658c3364fe64287caf1f9717ad323681f2e860ad1'
template_source: 'source checkout; unreleased working candidate'
template_provenance: 'template_sha256 retains historical rendering provenance; current_source_template_sha256 records the amended source template basis'
current_source_template_sha256: 'fcd30354c662a33b2224ac3943e3aefe01d7b46dc5c5e6b936b0bb6b7be13db7'
current_source_template_measured_at: '2026-10-04'
review_selection_decided_by: 'duongvm (Human)'
review_selection_decided_at: '2026-10-03'
review_selection_authority: '/tmp/paseo-slp-review-selection-20261003/assignment.md; Human-approved selection and source-protocol budget change'
routing_intent: 'pinned'
routing_change_decided_by: 'Hugo (configuração de equipes por projeto)'
routing_change_date: '2026-11-01'
routing_change_note: 'Catálogo explícito .paseo-slp/slp-routing.json para Dev, Revisor e QA; válido somente neste repositório; preservar autoridade histórica de upstream'
supervisor_notebook: '.paseo-slp/notebook.md (owner: Supervisor)'
decided_by: 'duongvm (Human)'
decided_at: '2026-09-30'
---

# Workspace Protocol

This repository's tactics apply under the current Human assignment and
installed role policy. AGENTS.md owns contributor/release boundaries;
repository/task instructions supply execution and E2E mechanics.

## Tactic

One Lead handles the assigned work; Supervisor is optional for governance and
continuity. Split only for authority/capacity under a Human formation mandate.
Lead selects the minimum useful topology and task-specific Peer disposition.
Direct bounded work can use one Engineer; add read-only architecture judgment
for material boundary, ownership, lifecycle, migration, dependency or
hard-to-reverse uncertainty. Architecture is conditional, not a Feature phase.
Investigate a failed premise before implementation/tests pin an unresolved
contract; missing owner/results/authority/capability return through the
installed request paths. Parallelize independent merge-safe work when capacity
allows, after scopes, shared resources, actual paths and integration owner
are declared. One integration owner verifies the resulting candidate.

Match proof/regression scope to acceptance and material blast radius, not
file count. Reuse valid candidate-bound evidence; repeat full-chain checks
for a proof question or repository gate. Tests verify settled behavior and
supply evidence for Lead judgment. Corrections target the accepted finding/
affected surface; broaden re-review when material risk, invalid proof or
changed contract/acceptance warrants it. Recurring classes require mechanism
analysis under installed review-gates.md rather than an unbounded patch loop.

Record a task-selected stop condition and authorized effort/resource bound
before continued correction/re-review/challenge, including council/mechanism
work. Stop on sufficient proof, unresolved premise/prerequisite or exhausted
bound; exhaustion is not ACCEPT. Escalate findings/proof/options for the
needed strategy/dependency/resource ruling. Candidate/seat/session changes
create no new authority or erased obligation.

Use installed Session continuity for fresh Peer assignments, healthy
same-assignment phases/rework and evidence-based handoff. Keep an idle
session only for assigned rework with an expiry. Monitoring needs an
assignment, owner and stop condition; it creates no hidden continuation.
A Supervisor observing a Lead whose Peers hold outstanding work arms one
Lead-level fallback heartbeat (about 30 minutes, expiring within 8 hours);
intermediate reports keep it, and it is deleted at Lead handback, Human stop
or reassignment.

## Gate

Independent review follows material decision-changing risk, uncertain proof,
hard-to-reverse decisions and explicit Human/assignment/protocol obligations.
For this repository, triggers include role authority/delegation, runtime
binding/transport, installation/upgrade/rollback and package behavior whose
proof is uncertain. Lead selects the minimum sufficient independent mandates
under installed references/review-gates.md, recording source/reason and
operative brief/scope/plan revision before the candidate round.
No material question/trigger permits reasoned not-required with candidate,
adequate proof and Lead verdict; it grants no waiver. Required gates stay
binding. Use installed review judgment and existing scope/tool pins; consume measured
proof rather than duplicate runtime bookkeeping. Independently verify
shell-reported checks and uncovered outcome questions. Local tests/records
are no E2E acceptance.

Mutation evidence additionally follows AGENTS.md's Human obligations:

- **R1:** every mutation log, including the acceptance owner's replay, carries
  verbatim `sha256sum <test file>` output captured immediately before the
  mutant runs, plus product hashes before/after and candidate identity.
  A declared meta hash alone is insufficient.
- **R2:** the replayed, pinned log is the evidence of record; Engineer's log
  supports it. Any mismatch among log, meta and handback candidate voids the
  log's claim without needing proof of intent.

When used, mutation evidence must drive a real assertion/input/fixture,
fail when the guarded behavior is removed and install spies/hooks before the
scenario without filters hiding relevant behavior. Include temporary mutant,
red log and confirmed revert. These obligations do not turn mutation testing
into a check for every task or establish acceptance.

Lead records ACCEPT, CHANGES_REQUESTED or BLOCKED on the exact candidate
and proof, with risks/resources. Delivery follows its grant; reconcile
resources and closed rework before archive under authorized installed
lifecycle rules. Release remains Human authority.

## Repository configuration

| Scope | Decision |
|---|---|
| Lead topology | One Lead; split only for authority or capacity under a Human formation mandate |
| Release | Release actions reserved in AGENTS.md; Human authority |
| Work state | Lead timeline for judgments; current desk projection for admitted operations when used; check evidence under .local-checks/ (never a competing work ledger) |
| Delivery/completion | Artifact and evidence for Human acceptance unless the assignment specifies otherwise |
| Settlement | Decisions made on the Human's behalf and in-task rulings go into the PR description; durable decisions go to `docs/decisions/` within the same candidate. SLP boundary: AGENTS.md §SLP boundary |

## Repository references

| Topic | Path | Read when |
|---|---|---|
| Skill layout | .paseo-slp/references/skill-layout.md | Adding, moving or assigning a skill |
| Upstream baseline | .paseo-slp/references/upstream-baseline.md | Running paseo-slp-upstream-sync |

## Overrides and provenance

The frontmatter preserves historical rendering package/template identity and
Human review-selection authority. current_source_template_sha256/date record
the newly measured source basis, not a rewritten historical provenance.
Guarded desk operations use their current projection. Authority, required
review, local R1/R2 and ordinary-path proof remain binding.

## Acordo operacional Hugo — 2026-11-01

Escopo: **Fork SLP**, tarefas pessoais de evolução de plugins; não implementar mudanças em repositórios ou ambientes de clientes a partir desta configuração.

- Comunicação: respostas, planos, relatórios, revisões e evidências em português do Brasil. Preservar IDs, comandos, nomes de APIs, parâmetros e hashes literais.
- Pipeline pretendido: Supervisor / Planejador (Lead) → Dev (Peer) → Revisor independente → QA independente → aguardando aprovação humana. A política customizada do fork ainda não é um gate ativo; não afirmar conclusão automática de etapas sem evidência real.
- Supervisor/Lead recebe objetivo e critérios de aceite; Dev implementa somente o escopo aprovado; Revisor/QA não podem homologar o próprio trabalho. QA reprovado volta ao Dev com evidências e até duas tentativas de retrabalho. Ausência de capacidade ou escopo duvidoso: bloquear e consultar o usuário.
- Não criar worktrees em ~/Projetos, ~/projetos ou dentro da raiz de projetos. Preferir workspace local já cadastrado e um único agente escritor por checkout; qualquer isolamento adicional exige local temporário autorizado e limpeza segura.
- Nunca executar merge, deploy, tag, release, alteração de dados reais ou ações em produção sem aprovação específica do usuário. Não atribuir cards, alterar estados, publicar comentários ou enviar mensagens no Multica/Azure/Jira/Teams sem o portão de aprovação do motor foco.
- Para integração de tarefas: Multica/Azure/Jira são fontes das tarefas e evidências; o plugin tasks/foco é a ponte. Não iniciar simultaneamente no Multica e no SLP a mesma tarefa; sem trava distribuída comprovada, não automatizar esse disparo.
- Não mover segredos nem dados de cliente para este repositório; registros e decisões devem conter links ou IDs sem tokens.
- Conservar skills já instaladas (`hugo-foco-do-dia`, `hugo-kepler-abrir-task-multica`) e usar `paseo-slp-onboarding` para revisão das regras por repositório.
- Este documento regula o comportamento de agentes. Não significa que o runtime SLP esteja ativado; conferir `slp status` e os perfis antes de iniciar uma tarefa gerenciada.


## Equipes — Operação Autônoma (Hugo)

Para tarefas **locais de desenvolvimento** explicitamente atribuídas
à equipe neste repositório, o mandato inclui decisões técnicas reversíveis,
delegação entre Supervisor, Líder, Desenvolvedor, Revisor e QA, execução de
testes e até duas rodadas de correção sem novas perguntas por fase.
Supervisor e Líder devem usar o Desk SLP e o pool deste repositório,
com revisão/QA independentes e uma única responsabilidade de escrita.
Não criar worktrees em ~/Projetos; preservar alterações existentes.

Sem autorização implícita para alterar tarefas no Multica, Azure ou Jira,
para publicar em sistemas de cliente, instalar serviços persistentes,
gerar cobranças, apagar trabalhos alheios, fazer commit/push/merge/tag,
release ou deploy. Se a origem é externa, não executar sem reserva
comprovadamente exclusiva e atual; em caso de dúvida, bloquear sem
reivindicar a tarefa. O pedido "somente planejar" não concede execução.


### Fallback de cota dos agentes (autorização limitada)

Para trabalhos locais de desenvolvimento explicitamente autorizados
neste repositório pessoal, se o Desenvolvedor Codex (dev-codex) sofrer
falha confirmada de cota, o Líder pode realizar UMA única tentativa de
substituição pelo preset dev-claude (Claude Sonnet 5.5, assinatura Max),
usando o quotaFallback do catálogo e o Desk para criar uma nova sessão.

Não autoriza compra, créditos, assinatura nova, API paga, publicação ou
modificação de tarefas externas. É obrigatório evidenciar o erro de cota,
verificar que não há outro escritor ativo no checkout, preservar a
sessão anterior e registrar a seleção. Erros diferentes de cota não
autorizam fallback. Sem segundo fallback: se Claude estiver
indisponível, registrar BLOCKED.

Revisor e QA continuam em sessões independentes, somente leitura.
Continuam proibidos commit, push, merge, release, tag, deploy, produção,
edição no Multica/Azure/Jira e worktrees sem autorização explícita.
Ao recuperar a cota do Codex, comprovar disponibilidade antes de
restaurar seu estado como ready.

## Gate de Homologação — E2E e regras por empresa

Esta política complementa o fluxo da equipe: resultados unitários,
parecer do Revisor ou aceite do Líder NÃO substituem prova E2E quando
a tarefa altera comportamento de usuário, integração, pipeline ou UI.

Antes do trabalho, identificar empresa/conta, projeto, fonte de tarefa,
repositório real, ambiente e regras de aceite. A autoridade do
repositório Pessoal vale somente para Pessoal: nunca transportar
seu pool, fallback, credenciais ou aprovações para TCERO,
CemigSim, DWLaw ou outras empresas. Em tarefas externas,
carregar a regra canônica da empresa do Cérebro e o protocolo
do projeto; escopo desconhecido, conflito ou falta de lock
verificável no controlador externo = BLOQUEADO.

No QA, guardar no destino autorizado FORA do repositório de
cliente: cenário e critérios, passo/entrada/esperado/obtido,
ambiente, agente/executor, data, identidade de versão/commit/hash
do candidato, comando e código de saída dos testes, logs,
evidência visual identificável para telas ou trace técnico para
API/integração, hash das provas e limitações de cobertura.
Revisor e QA devem ser independentes do escritor.

A suíte obrigatória deve ficar verde no ambiente homologado.
Um baseline com falhas não é sinal verde para liberar um
candidato: registrar as diferenças, sanar a falha ou BLOCKED
com decisão explícita sobre a limitação. Testes simulados,
prints de código e relatos de agentes não contam como prova
E2E real.

A ausência de cenário E2E requerido, versão pinada, prova
de execução, evidência visual quando necessária, garantia de
isolamento ou autorização empresarial exige resultado
NOT_HOMOLOGATED/BLOCKED. Nenhum agente pode converter
ACCEPT técnico em release, merge, tag ou deploy nesse estado.
Quando não existir ambiente ou automação para coletar as
provas, registrar CAPABILITY_GAP, em vez de inventá-las.

