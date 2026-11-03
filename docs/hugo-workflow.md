# Hugo Workflow — desenho inicial (não instalado)

Status: **proposta técnica versionada**, não implementação pronta. Este branch é uma área de desenvolvimento e não deve ser instalado no Paseo até validação e aprovação.

## Objetivo
Usar Paseo SLP como camada de governança de agentes, reaproveitando a execução nativa do Paseo e o plugin `tasks` + motor `foco` existentes. Não criar segundo cadastro autoritativo de cards nem duplicar credenciais do Azure/Jira/Multica.

## Papéis e responsabilidades
- **Supervisor / Orquestrador**: recebe objetivo, mantém contexto, controla prioridades e comunica decisões que exigem o humano. Não altera código.
- **Planejador / Lead**: consulta tarefa e origem, Cérebro e documentação; registra critérios de aceite, escopo, dependências, responsáveis e riscos. Não implementa.
- **Dev / Peer Engineer**: modifica somente os arquivos autorizados; desenvolve e executa testes unitários/integrados. Registra commit/candidato e evidências.
- **Revisor / Peer Reviewer**: leitura independente de diff, segurança, regressão, arquitetura e requisitos; não aprova o próprio trabalho.
- **QA / Peer Validator**: reproduz cenários e critérios de aceite no candidato estável, com evidências reais. Reprovação devolve achados ao Dev.
- **Humano**: mantém aprovação exclusiva de produção, release/tag, alterações de dados reais e decisões de escopo sensíveis.

## Fluxo desejado
TRIAGEM → PLANEJAMENTO → IMPLEMENTAÇÃO → REVISÃO → QA → PRONTO_PARA_APROVAÇÃO.
- Falha em revisão/QA: devolução ao Dev, com até duas reiterações automáticas (configurável). Excedido o limite, BLOQUEADO para decisão humana.
- PRONTO não é PRODUÇÃO. Merge, deploy, tag, publicação e alterações em origem/Multica/Teams passam pelos gates existentes de autorização.
- O estado do SLP deve espelhar execução, não sobrescrever os estados oficiais; atualizar cards somente pelo fluxo `foco_propor` → aprovação → `foco_publicar`.

## Base por empresa (regra obrigatória, todos os papéis)
Espelha os agentes do Multica, que têm regras próprias por empresa. Antes de agir, todo papel (Supervisor, Líder, Peer) identifica a empresa pelo repositório, lê as fontes dela (Cérebro: `_Inicio.md` → `_Protocolo.md` → `Projetos/<Empresa>/_mapa.md` → Decisoes/Acessos/Riscos; Multica da empresa, só leitura; origem Azure/Jira) e aplica as regras da empresa: identidade git, fluxo de branch/tag/produção, portão de Quality, nomenclatura e aprovação de publicação. Falta de acesso a uma fonte é `CAPABILITY_GAP`, nunca prosseguir às cegas; evidência, estado e identidade de uma empresa não valem para outra.
- A regra cross-project é `src/common.md` (vai a todos os papéis, inclusive Peer) e não nomeia empresa nem fonte do Hugo.
- Fontes, identidade e regras de cada empresa não são copiadas para a política de papéis: vêm do contexto empresarial por empresa que o host injeta (registro `~/.config/equipes/companies.json`, vinculado pelo Git common-dir e pelo hash da origem) e do Cérebro (`Skills/Multica/hugo-<empresa>-cliente`, fonte única também para o Multica). Enquanto o contexto empresarial não estiver integrado, Supervisor/Líder passam a empresa, a identidade e as fontes no assignment e o Peer as confirma no handback.

## Integrações e fonte da verdade
- **Tarefa, status, evidências**: Multica; **pedido do cliente**: Azure DevOps/Jira; **contexto**: Cérebro/Obsidian; **execução**: Paseo.
- Adapters de leitura reaproveitam o plugin `tasks` e o motor `foco`; nenhuma credencial ou token no repositório.
- Não instalar novos serviços persistentes, daemons ou apps web separados sem justificativa.
- Um projeto por origem/empresa, com isolamento de credenciais e workspaces.

## Máquinas e diretórios
- Mac M4: iOS/macOS, controle do fluxo, aprovações e ferramentas que exijam macOS.
- Desktop WSL: .NET, builds e testes Linux quando VPN/SDK/rede estiverem disponíveis e validados.
- Um escritor por escopo de trabalho, sem duas alterações concorrentes no mesmo checkout.
- **Não criar worktrees em `~/projetos`** (nem na árvore de projetos original do usuário). Worktrees de trabalho somente em local temporário explicitamente autorizado, com limpeza controlada por estado; não apagar branches/artifacts com trabalho pendente.
- Emulador Android compartilhado: apenas uma instância, com fila.

## Gates e observabilidade
- Validação independente por Revisor/QA e indicação exata do candidato (commit/ref), critérios, checks reais e pendências.
- Não confundir teste unitário com E2E, nem status idle com conclusão.
- Painel futuro: card, origem, etapa atual, responsável/agente, host, sessões, bloqueios, PR, evidências e ação humana pendente.
- Logs redigidos sem segredos; provas e artefatos permanecem no Multica, com link no Cérebro.

## Entregas em fases
1. **Foundation**: mapear contratos SLP v0.4.x e compatibilidade Paseo 0.14.0, testes isolados e lacunas da API `tasks`/`foco`.
2. **Workflow engine**: estado por tarefa, transições e loops limitados; perfis configuráveis.
3. **Adapters**: origem/Multica somente leitura no início; escrita apenas mediante aprovação formal.
4. **UI e host routing**: painel integrado no Paseo, Mac/WSL com fallback seguro.
5. **Piloto**: testar com tarefa pessoal sem credenciais de clientes, sem produção, com rollback documentado.

## Regras para o desenvolvimento do fork
- Preservar a licença MIT e atribuição ao autor original.
- Manter `upstream` sincronizável e alterações em módulos específicos; não modificar `main` sem revisão.
- Usar documentação e testes do projeto original: `npm test`, `npm run typecheck`, `npm run check`, `npm run check:plugin-payload`.
- Não permitir execução automática de agentes ao instalar ou carregar o plugin.
- Antes de implementar, verificar na prática API/runtime do SLP, contratos e compatibilidade com `tasks`.
