# Delegation — Supervisor and Lead

Check desk binding first (slp_status if available); use bound slp_seat_create
for Lead/Peer, including existing worktrees (references/delegation-execution.md).
Peer default: omit runtime/selection for server pool/Jev choice;
choices need selection.optionId; ambiguous V2 needs selection.thinkingOptionId.
New worktree: Paseo create_workspace under host-setup authority, then
slp_seat_create placement existing. create_agent remains compatibility/recovery.
Keep uncertain seat IDs; never recreate.
slp_seat_create creates a Paseo agent through the desk that the Human can
inspect and chat with, satisfying Paseo create_agent/inspectability rules;
repository rules, protocol clauses or Human instructions
forbidding desk creation or requiring another formation path exclusively override this default.

## Equipes — execução contínua para mandato de desenvolvimento

Quando o Workspace Protocol do repositório contiver o cabeçalho literal
"## Equipes — Operação Autônoma (Hugo)", a tarefa atribuída for de
desenvolvimento local e o pedido humano autorizar a execução, opere
sem solicitar aprovações repetidas para cada fase. Uma solicitação
expressamente "somente planejamento", "somente leitura", "não delegar"
ou um STOP tem precedência: NÃO transforme um plano em execução.
A instrução de autonomia é uma regra de condução, NÃO uma permissão
adicional do sistema, de ferramentas, de despesas ou de ambientes.

Supervisor: encaminhe o resultado e o escopo ao Líder no workspace já
existente, acompanhe as conclusões e dependências e não transforme um
plano aprovado em mais uma aprovação apenas para criar agentes.
Líder: ao receber mandato de desenvolvimento, distribua e acompanhe
o ciclo Planejador (quando necessário) → Desenvolvimento → Revisão
independente → QA independente. Use exclusivamente os mecanismos
nativos do Desk (slp_status, slp_assignment_*, slp_task_*, slp_seat_create
e notificações) e as opções válidas do Peer pool do REPOSITÓRIO.
Não abra tickets paralelos em Multica/Tasks. Não trate estado de agente
"ocioso" como trabalho aceito nem substitua os recibos do Desk.

Uma tarefa/revisão aprovada em etapa autoriza a próxima etapa TÉCNICA
já contida no mesmo escopo: selecionar Peer, criar seat quando permitido
pela autoridade do Desk, enviar brief, examinar diff, executar testes,
solicitar correções e colher handback. Preservar sessões, mudanças locais
preexistentes e lock/owner do checkout. Antes de qualquer escrita,
verificar trabalho concorrente no mesmo checkout e quem detém o escopo;
se houver titularidade/estado externo incerto, PAUSAR sem criar substituto.
"Outro agente ocioso", cache de Multica ou chave textual de controle não
constituem reserva atômica. Se a origem da tarefa for Multica, Azure,
Jira ou outra origem externa, não reivindicar a execução sem uma reserva
verificável do controlador correspondente. Na ausência dessa integração,
limitar-se a tarefas locais sem chave externa, ou bloquear.

O Desenvolvedor entrega um candidato identificável e evidências dos
testes executados. O Revisor, em sessão/agente DIFERENTE do escritor,
faz revisão independente do candidato atual. Só após revisão aprovada,
QA, também em sessão independente do Desenvolvedor, verifica critérios
de aceite e testes reproduzíveis. Rejeição do Revisor ou do QA retorna
ao mesmo escopo do Desenvolvedor com achados/evidências, seguida de
nova revisão e novo QA; no máximo DUAS rodadas de retrabalho no total.
Nunca declarar aprovação por silêncio, resultado de teste autorreportado
ou troca de modelo. Sem evidência atual, BLOQUEAR.

Não pedir nova autorização ao humano por decisões técnicas reversíveis
dentro do mandato. Pedir decisão apenas por impedimento real sem saída
segura, alteração relevante de escopo/custo, credencial, acesso protegido,
produção, operação irreversível ou publicação externa; também não fazer
commit/push/merge/tag/release/deploy quando não autorizados explicitamente.
Ao fim, consolidar um único relatório com resultado, provas, bloqueios
e mudanças ainda aguardando decisão. Sem agendamento oculto: só continuar
enquanto uma atribuição ativa, eventos e monitoramento autorizado permitirem.
Se faltar uma capacidade do SDK/Desk, declarar CAPABILITY_GAP e não
substituir por scripts paralelos ou contas/API pagas.

Supervisor/Lead use saved profiles. A direct Lead write requires an explicit
Human assignment or current effective protocol grant for clear, reversible
work, bounded scope, one writer and exact candidate proof.
Supervisor/Lead cancel only their owned task agents through Paseo cancel_agent
and stop their task-local wakes under references/monitoring.md; preserve sessions/artifacts.

Choose fresh Peers for new bounded outcomes; before Peer reuse, read
references/orchestration.md for continuation and Human exceptions.
Prompting a standalone seat cannot form a new delegation. Keep the team's
pinned workspace unless actual isolation requires another.

When dispatching desk tasks, not forming seats, read references/task-execution.md and
consume admission receipts for reservations, seat pins and effects.
For ordinary/Lean creation or observation, read references/delegation-execution.md
for receipts/compatibility verification.
Before runtime choice/settings/fallback, read references/provider-routing.md.
Unavailable tools grant no bypass.

Lead records review selection before each candidate: minimum sufficient
independent mandates for material questions/obligations.
Missing selection remains open; unavailable reviewers or adverse findings
never relax required gates.
Before selecting reviewers, read references/review-gates.md.
Tiny classification reduces ceremony, never authority, ownership,
parentage or required review; reassess scope/risk growth.
