🔐 Microserviço de Autenticação — Projeto de Portfólio Arquitetural

Este repositório contém um microserviço de autenticação em Node.js, desenvolvido como projeto de portfólio técnico, com foco em arquitetura, separação de responsabilidades, segurança básica e observabilidade.

O projeto foi desenvolvido entre junho e julho de 2025, com apoio do GitHub Copilot, e tem como objetivo demonstrar decisões arquiteturais conscientes, incluindo seus custos e limitações.

Contexto:
Este serviço não resolve uma demanda real de negócio específica. Ele foi construído intencionalmente como um exercício de overengineering controlado, para fins de estudo e demonstração técnica.

🎯 Objetivo

Demonstrar, em um sistema funcional:

Um serviço de autenticação isolado

Uso prático de arquitetura hexagonal (ports & adapters)

Separação clara entre domínio, infraestrutura e interface HTTP

Implementação de preocupações não-funcionais:

segurança básica

observabilidade

escalabilidade horizontal simples

Código testável e organizável ao longo do tempo

O foco não é inovação, e sim clareza estrutural e previsibilidade.

⚖️ Considerações arquiteturais (importante)

Este projeto não defende que autenticação deva ser sempre um microserviço separado.

Na prática:

Para muitos sistemas, um monólito modular é mais simples e eficiente.

Em cenários corporativos, um IdP dedicado (Auth0, Keycloak, Cognito) costuma ser superior.

Um microserviço de login só se justifica quando há:

múltiplos consumidores

SSO real

times independentes

necessidade clara de isolamento

Este projeto existe para explorar o “como”, não para afirmar o “quando”.

🧱 Funcionalidades implementadas

Autenticação com JWT

Estratégias com Passport.js

Arquitetura hexagonal

Clustering nativo do Node.js

Rate limiting (IP e tentativas de login)

Sanitização de entradas

Auditoria de eventos de autenticação

Métricas Prometheus

Health checks

Docker / Docker Compose

Testes unitários, integração e carga

Tudo listado acima está implementado e funcional, mas dentro de um escopo educacional.

🛠️ Arquitetura

O projeto segue arquitetura hexagonal para:

Isolar regras de negócio de frameworks

Reduzir acoplamento com infraestrutura

Facilitar testes unitários sem dependências externas

Permitir troca de adapters sem impacto no core

Estrutura geral:

src/
├── app.js                # Bootstrap + cluster
├── core/                 # Domínio e regras de negócio
├── adapters/             # Infraestrutura (crypto, cache, logs)
├── web/                  # Interface HTTP
├── middleware/           # Segurança e validações
├── config/               # Configuração e bootstrap
├── models/               # Persistência
├── routes/               # Rotas HTTP
└── utils/                # Métricas, health, erros


Nada aqui é experimental; é uma aplicação direta de padrões conhecidos.

🔒 Segurança (escopo e limites)

O serviço implementa:

Rate limiting

Sanitização de input

Headers de segurança (Helmet)

Detecção básica de padrões suspeitos

Auditoria de eventos sensíveis

Isso não substitui:

WAFs

serviços gerenciados

ou soluções especializadas

O objetivo é demonstrar integração e organização, não competir com ferramentas dedicadas.

📊 Observabilidade

Endpoint /metrics (Prometheus)

Logs estruturados

Health check com validação de dependências

Separação de workers em ambiente clusterizado

Novamente: foco em visibilidade mínima aceitável, não em stack enterprise completa.

⚙️ Setup
git clone https://github.com/dioneyfroes-coder/micrologin.git
cd micrologin
npm install
cp .env.example .env
docker-compose up -d
npm run dev


Swagger:

https://localhost:3000/api-docs

🧪 Testes

Testes unitários (core isolado)

Testes de integração

Testes de carga com Artillery

MongoDB em memória no ambiente de teste

O foco é confiabilidade estrutural, não métricas artificiais de cobertura.

📌 Status do Projeto

Funcional

Estruturalmente consistente

Documentado

Overengineering intencional

Voltado a portfólio e estudo arquitetural

📎 Conclusão

Este projeto não existe porque o mercado precisa de mais um sistema de autenticação.
Ele existe para mostrar como eu estruturo código, tomo decisões arquiteturais e lido com trade-offs técnicos.

Avalie este repositório como demonstração de pensamento técnico, não como produto pronto para adoção irrestrita.

📄 Licença

MIT

Dioney Froes
Junho – Julho 2025
Projeto de portfólio arquitetural (Node.js)
