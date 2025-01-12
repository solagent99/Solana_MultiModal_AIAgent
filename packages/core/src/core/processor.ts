import { LLMClient } from "./llm-client";
import { type ClientEvent, type CoreEvent } from "../types";
import { type ActionRegistry } from "./actions";
import { type IntentExtractor } from "./intent";
import { Logger } from "./logger";
import { type Room } from "./room";
import { type VectorDB } from "./vectorDb";
import { type Character, defaultCharacter } from "./character";
import { type SearchResult } from "../types";
import { LogLevel } from "../types";
export interface ProcessedIntent {
  type: string;
  confidence: number;
  action?: string;
  parameters?: Record<string, any>;
}

export interface EnrichedContext {
  timeContext: string;
  summary: string;
  topics: string[];
  relatedMemories: string[];
  sentiment?: string;
  entities?: string[];
  intent?: string;
  similarMessages?: any[];
  clientVariables?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface ProcessingResult {
  intents: ProcessedIntent[];
  suggestedActions: CoreEvent[];
  enrichedContext: EnrichedContext;
}

interface EnrichedContent {
  originalContent: string;
  timestamp: Date;
  context: EnrichedContext;
}

// Type guard for VectorDB with room methods
interface VectorDBWithRooms extends VectorDB {
  storeInRoom: (
    content: string,
    roomId: string,
    metadata?: Record<string, any>
  ) => Promise<void>;
  findSimilarInRoom: (
    content: string,
    roomId: string,
    limit?: number,
    metadata?: Record<string, any>
  ) => Promise<SearchResult[]>;
}

function hasRoomSupport(vectorDb: VectorDB): vectorDb is VectorDBWithRooms {
  return "storeInRoom" in vectorDb && "findSimilarInRoom" in vectorDb;
}

export class EventProcessor {
  private logger: Logger;

  constructor(
    private vectorDb: VectorDB,
    private intentExtractor: IntentExtractor,
    private llmClient: LLMClient,
    private actionRegistry: ActionRegistry,
    private character: Character = defaultCharacter,
    logLevel: LogLevel = LogLevel.INFO
  ) {
    this.logger = new Logger({
      level: logLevel,
      enableColors: true,
      enableTimestamp: true,
    });
  }

  async process(event: ClientEvent, room: Room): Promise<ProcessingResult> {
    this.logger.debug("EventProcessor.process", "Processing event", {
      type: event.type,
      source: event.source,
      roomId: room.id,
    });

    // First, classify the content
    const contentClassification = await this.classifyContent(event);

    // second, generate intents
    const intents = await this.generateIntents(contentClassification, event);

    // third, enrich content
    const enrichedContent = await this.enrichContent(
      event.content,
      room,
      event.timestamp
    );

    // Use type guard for room operations
    if (this.vectorDb && hasRoomSupport(this.vectorDb)) {
      await this.vectorDb.storeInRoom(event.content, room.id, {
        ...event.metadata,
        ...enrichedContent.context,
        eventType: event.type,
        timestamp: event.timestamp,
      });
    }

    const suggestedActions = await this.generateActions(intents, room);

    return {
      intents,
      suggestedActions,
      enrichedContext: enrichedContent.context,
    };
  }

  private async generateIntents(
    classification: { contentType: string; context: Record<string, any> },
    event: ClientEvent
  ): Promise<ProcessedIntent[]> {
    const availableActions = this.actionRegistry.getAvailableActions();

    const prompt = `Given the following classified content and available actions, determine appropriate intents:

Content Classification:
- Type: ${classification.contentType}
- Context: ${JSON.stringify(classification.context)}

Original Content: "${event.content}"

Available Actions:
${Array.from(availableActions.entries())
  .map(
    ([type, def]) => `
- ${type}:
  Description: ${def.description}
  EventType: ${def.eventType}
  Platforms: ${def.targetPlatforms.join(", ")}
`
  )
  .join("\n")}

Generate intents that are appropriate for this type of content and map to available actions.
Use EventType for the type field.`;

    return this.intentExtractor.extract(event.content, prompt);
  }

  private async classifyContent(event: ClientEvent): Promise<{
    contentType: string;
    context: Record<string, any>;
  }> {
    const prompt = `Classify the following content and provide context:

Content: "${event.content}"
Source: ${event.source}
Type: ${event.type}
Metadata: ${JSON.stringify(event.metadata)}

Determine:
1. What type of content this is (tweet, question, statement, etc.)
2. What kind of response or action it requires
3. Any relevant context

Return JSON only:
{
  "contentType": "tweet|question|statement|etc",
  "requiresResponse": boolean,
  "context": {
    "topic": "string",
    "urgency": "high|medium|low",
    "additionalContext": "string"
  }
}`;

    const classification = await this.llmClient.analyze(prompt, {
      system: "You are an expert content classifier.",
      temperature: 0.3,
      formatResponse: true,
    });

    return typeof classification === "string"
      ? JSON.parse(this.stripCodeBlock(classification))
      : classification;
  }

  private stripCodeBlock(text: string): string {
    // First remove markdown code block markers if present
    text = text
      .replace(/^```[\w]*\n/, "")
      .replace(/\n```$/, "")
      .trim();

    // Find the first occurrence of a valid JSON object
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    return jsonMatch ? jsonMatch[0] : text;
  }

  private async enrichContent(
    content: string,
    room: Room,
    timestamp: Date
  ): Promise<EnrichedContent> {
    // Use type guard for getting related memories
    const relatedMemories =
      this.vectorDb && hasRoomSupport(this.vectorDb)
        ? await this.vectorDb.findSimilarInRoom(content, room.id, 3)
        : [];

    const prompt = `Analyze the following content and provide enrichment:

Content: "${content}"

Related Context:
${relatedMemories.map((m: SearchResult) => `- ${m.content}`).join("\n")}

Provide a JSON response with:
1. A brief summary (max 100 chars)
2. Key topics mentioned (max 5)
3. Sentiment analysis
4. Named entities
5. Detected intent/purpose

Response format:
\`\`\`json
{
  "summary": "Brief summary here",
  "topics": ["topic1", "topic2"],
  "sentiment": "positive|negative|neutral",
  "entities": ["entity1", "entity2"],
  "intent": "question|statement|request|etc"
}
\`\`\`
Return only valid JSON, no other text.`;

    try {
      const enrichment = await this.llmClient.analyze(prompt, {
        system:
          "You are a helpful assistant that generates actions based on intents.",
        temperature: 0.3,
        formatResponse: true,
      });

      let result;
      try {
        const cleanJson =
          typeof enrichment === "string"
            ? this.stripCodeBlock(enrichment)
            : enrichment;

        result =
          typeof cleanJson === "string" ? JSON.parse(cleanJson) : cleanJson;

        // Validate required fields
        if (!result.summary || !Array.isArray(result.topics)) {
          throw new Error("Invalid response structure");
        }
      } catch (parseError) {
        this.logger.warn(
          "EventProcessor.enrichContent",
          "Failed to parse LLM response, retrying with stricter prompt",
          {
            error:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
            response: enrichment,
          }
        );

        // Retry with stricter prompt
        const retryPrompt = `${prompt}\n\nIMPORTANT: Respond with ONLY the JSON object, no markdown, no explanations.`;
        const retryResponse = await this.llmClient.analyze(retryPrompt, {
          system:
            "You are a helpful assistant that generates actions based on intents.",
          temperature: 0.2, // Lower temperature for more consistent formatting
          formatResponse: true,
        });

        result =
          typeof retryResponse === "string"
            ? JSON.parse(this.stripCodeBlock(retryResponse))
            : retryResponse;
      }

      return {
        originalContent: content,
        timestamp,
        context: {
          timeContext: this.getTimeContext(timestamp),
          summary: result.summary || content.slice(0, 100),
          topics: Array.isArray(result.topics) ? result.topics : [],
          relatedMemories: relatedMemories.map((m: SearchResult) => m.content),
          sentiment: result.sentiment || "neutral",
          entities: Array.isArray(result.entities) ? result.entities : [],
          intent: result.intent || "unknown",
        },
      };
    } catch (error) {
      this.logger.error("EventProcessor.enrichContent", "Enrichment failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return basic enrichment on failure
      return {
        originalContent: content,
        timestamp,
        context: {
          timeContext: this.getTimeContext(timestamp),
          summary: content.slice(0, 100),
          topics: [],
          relatedMemories: relatedMemories.map((m: SearchResult) => m.content),
          sentiment: "neutral",
          entities: [],
          intent: "unknown",
        },
      };
    }
  }

  private getTimeContext(timestamp: Date): string {
    const now = new Date();
    const hoursDiff = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);

    if (hoursDiff < 24) return "very_recent";
    if (hoursDiff < 72) return "recent";
    if (hoursDiff < 168) return "this_week";
    if (hoursDiff < 720) return "this_month";
    return "older";
  }

  private async generateActions(
    intents: ProcessedIntent[],
    room: Room
  ): Promise<CoreEvent[]> {
    const actions: CoreEvent[] = [];

    // Add debug logging to see what intents we're receiving
    this.logger.debug("EventProcessor.generateActions", "Processing intents", {
      intents,
    });

    for (const intent of intents) {
      try {
        const availableActions = this.actionRegistry.getAvailableActions();

        // Add debug logging for available actions
        this.logger.debug(
          "EventProcessor.generateActions",
          "Available actions",
          {
            actionCount: availableActions.size,
            actions: Array.from(availableActions.keys()),
          }
        );

        let prompt = `Given the following intent and available actions, determine the most appropriate action to take.
        YOU MUST RESPOND WITH A SINGLE VALID JSON OBJECT AND NOTHING ELSE.
        Required JSON structure:

        \`\`\`json
        {
            "selectedAction": "action_type_here",
            "confidence": 0.0-1.0,
            "parameters": {
                "content": "action content here",
                // other parameters as needed
            },
            "reasoning": "brief explanation"
        }
        \`\`\`

Intent:
- Type: ${intent.type}
- Confidence: ${intent.confidence}
- Parameters: ${JSON.stringify(intent.parameters, null, 2)}

Available Actions:
${Array.from(availableActions.entries())
  .map(
    ([type, def]) => `
- ${type}:
  Description: ${def.description}
  Platforms: ${def.targetPlatforms.join(", ")}
  Parameters: ${JSON.stringify(def.parameters, null, 2)}
`
  )
  .join("\n")}

IMPORTANT: Return ONLY the JSON object with no additional text or explanations.`;

        console.log(intent);

        // If this is a tweet-related action, append the tweet template
        if (intent.type.includes("tweet")) {
          const tweetTemplate = await this.enrichPrompt(
            this.character.templates?.tweetTemplate || "",
            {
              context: intent.parameters?.context || "",
            }
          );
          prompt += `\n\nWhen generating tweet content, use this template for tone of voice:\n${tweetTemplate}`;
        }

        console.log(prompt);

        const response = await this.llmClient.analyze(prompt, {
          system:
            "You are Ser blob, a crypto, market, geopolitical, and economic expert. You speak like an analyst from old times.",
          temperature: 0.8,
          formatResponse: true,
        });

        // Add debug logging for LLM response
        this.logger.debug("EventProcessor.generateActions", "LLM response", {
          response,
        });

        let result;
        try {
          result =
            typeof response === "string"
              ? JSON.parse(this.stripCodeBlock(response))
              : response;
        } catch (parseError) {
          this.logger.error(
            "EventProcessor.generateActions",
            "Failed to parse LLM response",
            {
              error:
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError),
              response,
            }
          );
          continue;
        }

        // Remove the strict confidence threshold to help with debugging
        // if (result.confidence >= 0.7) {  // Comment out or lower this threshold temporarily
        if (result.selectedAction && result.confidence >= 0.7) {
          // Just check if an action was selected
          const actionDef = this.actionRegistry.getActionDefinition(
            result.selectedAction
          );

          if (actionDef) {
            const event: CoreEvent = {
              type: actionDef.eventType,
              target: actionDef.clientType,
              content: result.parameters?.content || "",
              timestamp: new Date(),
              metadata: {
                ...result.parameters,
                intent: intent.type,
                confidence: result.confidence,
                reasoning: result.reasoning,
                originalParameters: intent.parameters,
              },
            };

            actions.push(event);

            this.logger.debug(
              "EventProcessor.generateActions",
              "Generated action event",
              { event }
            );
          }
        }
      } catch (error) {
        this.logger.error(
          "EventProcessor.generateActions",
          "Failed to generate action",
          {
            error: error instanceof Error ? error.message : String(error),
            intentType: intent.type,
          }
        );
      }
    }

    // Add final debug logging
    this.logger.debug("EventProcessor.generateActions", "Generated actions", {
      actionCount: actions.length,
      actions,
    });

    return actions;
  }

  private async enrichPrompt(prompt: string, context: any): Promise<string> {
    return prompt.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (key === "name") return this.character.name;
      if (key === "voice") return this.character.voice.tone;
      if (key === "emojis") return this.character.voice.emojis.join(" ");
      if (key === "topics")
        return this.character.instructions.topics.join(", ");
      return context[key] || match;
    });
  }
}
