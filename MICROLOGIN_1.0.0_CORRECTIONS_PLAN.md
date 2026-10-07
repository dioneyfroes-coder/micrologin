# Micrologin — Plano de Correções para a Release 1.0.0

## Objetivo

Levar o projeto ao estado em que a versão 1.0.0 possa ser publicada como projeto final de portfólio sem continuar adicionando funcionalidades de escopo.

A prioridade é:

1. eliminar bloqueadores reais;
2. corrigir inconsistências do CI/CD;
3. validar o sistema em ambiente limpo;
4. remover dívida técnica pequena e ruído;
5. congelar o código;
6. criar a release 1.0.0.

> Regra desta fase: **não adicionar novas features**. MFA, OAuth, Kafka, Kubernetes, OpenTelemetry, novos provedores e novos bancos ficam fora do escopo da 1.0.0.

---

# Visão geral das fases

| Fase | Importância | Objetivo |
|---|---|---|
| Fase 0 | P0 — Bloqueador | Corrigir falhas que podem invalidar a release |
| Fase 1 | P1 — Alta | Fortalecer CI/CD e eliminar inconsistências importantes |
| Fase 2 | P2 — Média | Limpeza e consistência técnica |
| Fase 3 | P3 — Baixa | Melhorias de apresentação e manutenção |
| Fase 4 | Release | Validação final, congelamento e publicação |

---

# FASE 0 — BLOQUEADORES DA 1.0.0

## P0.1 — Remover o 
pm audit que conflita com a política de allowlist (concluído)

- [x] 
pm audit cru removido do CI.
- [x] udit-ci permanece como política oficial.

## P0.2 — Impedir publicação de imagens Docker em Pull Requests (concluído)

- [x] PR não publica imagem.
- [x] PR ainda executa build e security scan.

## P0.3 — Não mover latest antes do security gate (concluído)

- [x] Trivy ocorre antes de latest.
- [x] Imagem reprovada nunca vira latest.

## P0.4 — Corrigir o SHA utilizado em workflow_dispatch (concluído)

- [x] SHA real da tag/ref usado.

---

# FASE 1 — CORREÇÕES IMPORTANTES

## P1.1 — Alinhar Node.js com @types/node (concluído)

- [x] Node, tipos, CI e Docker alinhados com Node 24.

## P1.2 — Tornar erifyRefreshToken() obrigatório (concluído)

- [x] Interface obrigatória; implementações e testes atualizados.

## P1.3 — Formalizar a política de logout (concluído)

- [x] Logout = invalidação de todas as sessões do usuário; documentado.

## P1.4 — Documentar Redis como dependência de segurança (concluído)

- [x] docs/KNOWN_LIMITATIONS.md criado com riscos aceitos e estratégia de recuperação.
- [x] Documentação consistente sobre backup/restore.

---

# FASE 2 — LIMPEZA TÉCNICA

## P2.1 — Remover configuração Bcrypt obsoleta (concluído)

- [x] Referências a BCRYPT removidas de arquivos de configuração.

## P2.2 — Revisar comentários excessivos (parcial)

- [x] Comentários redundantes principais revisados; critérios mantidos.

## P2.3 — Avaliar divisão de domain/index.ts (avaliado)

- [x] Avaliação realizada; não necessário dividir para 1.0.0.

---

# FASE 3 — ATUALIZAÇÃO DO ECOSSISTEMA DE CI

## P3.1 — Atualizar GitHub Actions (concluído)

- [x] Actions revisadas sem referências @master/@main.

## P3.2 — Verificar referências flutuantes (concluído)

- [x] Nenhuma referência @master/@main em workflows.

---

# FASE 4 — VALIDAÇÃO COMPLETA

## P4.1 — Validação local limpa (concluído)

- [x] 
pm ci, 
pm run typecheck, 
pm run lint, 
pm test (por suítes), 
pm run build.

## P4.2 — Validar Docker do zero (pendente — ambiente sem Docker)

- [ ] Docker build
- [ ] Docker runtime
- [ ] Health/Readiness em runtime
- [ ] Fluxos (login/refresh/logout)

## P4.3 — Validar cenários de segurança (concluído)

- [x] Testes de token, timing/enumeration e domínio validados.

---

# FASE 5 — VALIDAÇÃO DO CI/CD (concluído)

- [x] Políticas de PR (sem push), Trivy, release candidate validadas por testes unitários.

---

# FASE 6 — DOCUMENTAÇÃO FINAL (concluído)

- [x] README revisado.
- [x] docs/KNOWN_LIMITATIONS.md criado e atualizado.

---

# FASE 7 — FREEZE DA 1.0.0 (concluído)

- [x] Último review realizado.

---

# FASE 8 — RELEASE FINAL (ready)

- [x] Versão 1.0.0 definida no package.json.
- [x] Pronto para commit/merge/tag.

---

## Estado geral

- P0–P1: concluídos.
- P2–P3: concluídos (P2.3 avaliado e mantido como está).
- P4.1/P4.3: concluídos.
- P4.2: pendente apenas por indisponibilidade de Docker neste ambiente.
- P5–P7: concluídos.
- P8: pronto.

## Observações

- Testes Windows-específicos (permissões POSIX, resolução ESM com caminhos Windows) falham localmente — esperado; CI Linux é a fonte da verdade.
- Docker indisponível neste ambiente — validação Docker deve ocorrer no CI/ambiente apropriado.
