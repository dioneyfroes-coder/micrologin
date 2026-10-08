# Política de segurança

Este documento explica como reportar uma vulnerabilidade no Micrologin e o que
esperar depois do reporte. Ele cobre **como reportar**, não a lista de riscos já
conhecidos — esses estão em [`docs/SEGURANCA.md`](docs/SEGURANCA.md) (threat
model, decisões e o que foi recusado) e em
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) (limitações assumidas).

## Versões suportadas

A correção de segurança é aplicada na versão mais recente publicada. Como o
projeto é um estudo de arquitetura e ainda está na primeira versão, só a linha
`1.x` recebe correção.

| Versão | Suportada para correção de segurança |
| --- | --- |
| `1.0.x` (atual) | Sim |
| anteriores a `1.0.0` | Não — não existe release anterior |

## Como reportar

**Não abra uma issue pública para relatar vulnerabilidade.** O repositório tem
o *private vulnerability reporting* do GitHub habilitado na aba **Security**:

1. acesse a aba **Security** do repositório;
2. clique em **Report a vulnerability**;
3. descreva o problema no formulário privado.

Se o formulário não estiver disponível, abra uma issue **sem detalhes**
pedindo um canal privado — o conteúdo técnico fica fora da issue pública.

Um bom reporte inclui o que for possível do conjunto abaixo:

- versão ou commit afetado;
- rota, fluxo ou arquivo envolvido (`/login`, `/refresh`, middleware, etc.);
- passos para reproduzir, com o mínimo de dados reais;
- impacto que você enxerga (ex.: bypass de revogação, exposição de token,
  autenticação indevida);
- prova de conceito, se houver — sem executar contra instância de terceiros.

## O que esperar

Este é um projeto de estudo mantido por uma pessoa, sem SLA contratual. O
compromisso é de **esforço razoável**:

- confirmação de recebimento e triagem inicial;
- avaliação de impacto e decisão de correção ou aceite documentado;
- crédito nos registros do projeto, se você quiser ser identificado.

## Escopo

**Dentro do escopo** — falhas no código e na configuração entregues por este
repositório:

- autenticação, emissão e verificação de JWT (access e refresh);
- rotação e detecção de reuso de refresh token, revogação e versão de sessão;
- hashing de senha (argon2id), pepper e parâmetros de custo;
- normalização de entrada e as regras de validação dos endpoints;
- rate limiting, semáforo de hash e comportamento sob Redis fora do ar;
- segredos versionados por engano, imagem Docker e pipeline de release.

**Fora do escopo:**

- infraestrutura onde você implantou (rede, proxy, host, secrets do seu
  ambiente e hardening do seu sistema operacional);
- dependências de terceiros sem correção disponível — o caminho é reportar no
  upstream (o repositório já registra o que é aceito e por quê em
  `.audit-ci.json` e no Trivy);
- limitações já declaradas e aceitas na 1.0.0
  ([`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md)); um reporte sobre
  elas é bem-vindo como discussão, mas não é tratado como vulnerabilidade nova;
- ataques que dependem de acesso físico, de credenciais administrativas ou de
  configuração intencionalmente insegura.

## Boas práticas ao testar

- teste só contra instância sua, local ou explicitamente autorizada;
- não exfiltre, altere nem retenha dados de outras pessoas;
- não use força bruta, carga ou varredura massiva contra instância que não é
  sua;
- prefira o menor PoC possível e evite deixar o serviço indisponível.
