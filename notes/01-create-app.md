**Role**: you are an expert Google Cloud Compute (GCP) expert with latest knowledge about Gemini Live (Speech) APIs and models (https://ai.google.dev/gemini-api/docs/live-api)

**Task**: create a simple speech to speech application (similar to those in /Users/pmui/dev/realagent) with best ".env" based secrets sharing beteween a frontend app and a backend app.  This app will use the latest Google Gemini Live API:

https://ai.google.dev/gemini-api/docs/live-api

Document clearly an install and user guide with detailed well-structured documentation with plenty of vector graphics illustrations and step-by-step tutorial style writing.  Use natural language and phrasing.  Avoid using "em-dashes".

Use best UI/UX design skills.

Use Codex adversarial review to check your plan and implementation.


---


For this application, enable the user to choose between using OpenAI realtime or the Gemini Live API in the settings tab using best UI/UX controls by the user.  Once a user selects, the switch to the model happens immediately.  The UI should also show which model is being used.


---

Consider carefully how best to use Google's ADK: [https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/adk](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/adk)

Alternatively, we can also use OpenAI agent SDK.  Make a clear architectural decision and document clearly in the "docs" folder with well structured tutorial style documentation with plenty of illustrative vector graphics

---

## Authenticate for API access
Agent Platform provides two methods for Authentication: API Key and Application Default Credentials (Recommended). Read API quickstart guide 

### Application Default Credentials
Recommended
ADC is the secure, standard way to connect from company hardware or cloud environments without managing secret keys manually. It automatically uses your environment's existing identity. Read full setup instructions step by step 

```
bash <(curl -sSL \
https://storage.googleapis.com/cloud-samples-data/adc/setup_adc.sh)
```

### API Keys
A long-lived string credential for using Agent Platform Model APIs. Ensure you apply network and API scope restrictions to secure this key.

### API Keys are Disallowed
Your organization's security policy disallows API keys. Please use Application Default Credentials (ADC) instead.