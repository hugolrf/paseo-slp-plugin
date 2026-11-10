O Paseo SLP permite delegar trabalhos complexos de desenvolvimento a uma equipe coordenada de agentes. O **Líder (Lead)** coordena e integra o trabalho; os **Especialistas (Peers)** executam atividades delimitadas de implementação, arquitetura e revisão; um **Supervisor** opcional acompanha a qualidade do processo e encaminha suas decisões. Você mantém a autoridade sobre objetivos, decisões importantes e aprovação final.

O plugin carrega as instruções de cada papel e mantém registros compartilhados no Paseo, permitindo identificar responsabilidades, decisões e evidências.

## Quando utilizar

- Existem dependências importantes entre as etapas e a implementação pode revelar uma premissa incorreta.
- Arquitetura, ciclo de vida ou responsabilidade precisam ser esclarecidos durante o trabalho.
- Múltiplos módulos, projetos, workspaces ou responsáveis precisam coordenar integrações.
- O trabalho é suficientemente longo ou complexo para exigir continuidade após interrupções.

Para atividades pequenas, bem definidas e sem dependências relevantes, um único agente geralmente é suficiente. Use o SLP quando a coordenação trouxer mais valor do que sua complexidade.

## Como o trabalho é organizado

Defina um objetivo delimitado para o **SLP Lead** ou comece pelo **SLP Supervisor**. O Líder escolhe os Especialistas necessários. Cada Especialista pode questionar premissas, apontar dependências ausentes e relatar impedimentos. Apenas um agente deve modificar cada escopo de trabalho por vez.

O arquivo `.paseo-slp/workspace-protocol.md` contém as regras específicas do repositório. Uma tarefa simples pode começar com um único Especialista de desenvolvimento; o Líder acrescenta Arquitetura ou Revisão conforme a necessidade.

O painel de trabalho mantém atribuições, especificações, decisões, dependências, revisões e evidências. A fila permite encaminhamento e integração sob comando do Líder. A transferência planejada preserva o histórico da atribuição. Abra **Ler trabalho SLP** no workspace para consultar os registros. O painel separa resultados declarados de evidências verificadas; a aprovação final continua sendo sua.

Cada integrante é um agente normal do Paseo e pode usar Codex, Pi, Devin, Claude Code, OpenCode ou Antigravity, inclusive com modelos diferentes na mesma equipe.

## O que muda na prática

| Problema | Como o SLP trata |
| --- | --- |
| Um agente recebe uma solução pronta e apenas a reproduz | O Líder delega resultados; o Especialista pode contestar a premissa. |
| Agentes paralelos sobrescrevem o trabalho uns dos outros | Um responsável por cada escopo de escrita, com isolamento apropriado. |
| A revisão valida uma mudança desatualizada ou influenciada pelo autor | Revisão independente de um candidato estável, repetida quando o escopo ou código muda. |
| Agente ocioso ou teste aprovado é confundido com entrega aceita | O Líder analisa o resultado integrado e suas evidências; você mantém a aprovação final. |

## Configuração

1. Instale e autentique ao menos uma CLI de provedor compatível no host do daemon e abra **SLP** na barra lateral. As CLIs disponíveis são descobertas automaticamente, antes da ativação; o Codex é opcional.
2. Em **SLP > Perfis**, escolha provedor e modelo explícito para Supervisor e Líder e selecione **Salvar perfis**. Confirme o daemon home e a janela exclusiva de configuração quando solicitado. Salvar aplica as escolhas e ativa o SLP para as próximas sessões.
3. **Manutenção > Configuração do runtime** continua disponível para atualizar o runtime, ajustar executáveis e recuperar a instalação.
4. Em cada repositório, use a skill `paseo-slp-onboarding` para propor `.paseo-slp/workspace-protocol.md` e o pool de Especialistas. Confira o diff antes de gravar.
5. Verifique se existe ao menos um Especialista habilitado no pool. Inicie a tarefa com o perfil SLP Supervisor ou SLP Lead.

Exemplo de pedido: *Corrija o arredondamento do valor total no checkout. Apresente o candidato e os testes efetivamente executados.*

Instalar ou ativar o plugin **não cria nenhum agente automaticamente**.

Consulte o [guia completo](https://github.com/hugolrf/paseo-slp-plugin#readme) para informações adicionais.

## Configurações e limites

- O gerenciador configura modelos do Supervisor e do Líder e o pool de provedores permitidos. O Líder define os papéis técnicos conforme cada tarefa.
- Recursos opcionais incluem idioma compartilhado, alternativa para cota esgotada, roteamento pelo Jev e supervisão da comunicação. Para manter as respostas dos agentes em português, selecione **Português do Brasil** na configuração de idioma de comunicação do SLP; escolhas já existentes devem ser preservadas.
- Um repositório pode fixar seu próprio pool em `.paseo-slp/slp-routing.json`, que tem precedência sobre o pool compartilhado.
- Alterações nos papéis valem para novos agentes, não para sessões em execução.
- O plugin não sobrescreve provedores ou perfis que não controla e interrompe alterações caso detecte configuração externa incompatível (`RECOVERY_REQUIRED`).
- As instruções dos papéis não substituem as permissões do Paseo, dos provedores ou do sistema operacional.
- O Antigravity aceita apenas modo de acesso completo: sua CLI pode aprovar ferramentas automaticamente, sujeita a bloqueios nativos. O esforço de raciocínio vem do ID do modelo. Sua integração MCP aceita stdio e Streamable HTTP; SSE legado não é compatível. Serviços MCP herdados continuam disponíveis e o roteamento não isola ferramentas. Veja [limites do Antigravity](https://github.com/duongvm57/paseo-slp-plugin/blob/main/docs/antigravity.md).

## Dados, arquivos, processos e rede

- **Configuração do Paseo:** a ativação modifica o `config.json` para registrar provedores e perfis e habilitar ferramentas MCP. A desativação remove essas entradas.
- **Estado do plugin:** configurações, registros e arquivos de runtime ficam em `<daemonHome>/slp-runtime/`, incluindo o pool compartilhado. Chaves do Jev usam arquivos com permissões 0600.
- **Arquivos temporários:** sessões Antigravity utilizam pastas privadas temporárias para MCP e imagens anexadas, removidas no encerramento. Endpoints e credenciais MCP são transmitidos pelo ambiente do processo; o adaptador não altera configurações compartilhadas do Antigravity.
- **Repositórios:** o plugin lê `.paseo-slp/`, sem gravar automaticamente o catálogo de roteamento. Os registros operacionais ficam no diretório privado de runtime do plugin. A integração de tarefas só aplica mudanças quando invocada pelo Líder e pode utilizar worktrees Git para isolamento. **Respeite sua política de diretórios antes de habilitar essa execução.**
- **Subprocessos:** o plugin identifica Node e CLIs disponíveis no `PATH`, executa verificações curtas e pode executar Git durante atribuições e integrações. Suas verificações incorporadas são limitadas a integridade do ledger, conferência do payload e `git rev-parse HEAD`. O Antigravity utiliza `agy`, processos Node e comandos MCP configurados.
- **Rede e credenciais:** as CLIs dos agentes enviam prompts, código e resultados aos provedores de modelos configurados na sua conta. Integrações MCP podem transmitir solicitações e cabeçalhos de autenticação aos endpoints configurados. Se habilitar Jev, dados de roteamento ou comunicação também poderão ser enviados ao OpenRouter ou à API TypeSafe System One. Avalie permissões e custos antes de usar.
- **Rastreadores externos:** este plugin não consulta Azure, Jira ou Multica diretamente; essas integrações dependem do seu plugin `tasks` e de adaptações posteriores.

## Requisitos

- Aplicativo e daemon Paseo 0.11.0 ou superior (host mínimo suportado, não a versão fixada do SDK), com plugins e MCP habilitados.
- Host Linux ou macOS; Windows nativo não é suportado.
- Node.js 22.18 ou superior da série 22, ou Node.js 23.6 ou superior, para TypeScript nativo.
- CLIs dos provedores escolhidos instaladas e autenticadas no host.
- Antigravity exige `agy` 1.4.4 ou superior e o plugin gerenciador; a instalação independente não registra seus provedores.
