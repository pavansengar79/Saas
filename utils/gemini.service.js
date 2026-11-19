// utils/gemini.service.js
// Gemini AI Service for Audit Log Analytics

const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiService {
  // Gemini is optional: without GOOGLE_GENERATIVE_AI_API_KEY the server still
  // starts, and only AI audit analytics is unavailable (controller returns 503).
  constructor() {
    this.model = null;
  }

  get isConfigured() {
    return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  }

  getModel() {
    if (!this.isConfigured) {
      throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not configured');
    }
    if (!this.model) {
      const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
      this.model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-1.5-flash'
      });
    }
    return this.model;
  }

  /**
   * Generate MongoDB aggregation pipeline from natural language query
   */
  async generateAggregationPipeline(userQuery, context = {}) {
    const { orgId, companyId, unitId, userId, role } = context;

    const systemPrompt = `You are an expert MongoDB aggregation pipeline generator for an HRMS audit log system.

IMPORTANT: Return ONLY valid JSON. No explanations, no markdown, no code blocks.

Schema reference:
- Collection: auditlogs
- Fields:
  - action: String (e.g., "LOGIN", "EMPLOYEE_CREATED", "LEAVE_APPROVED", "PUNCH_IN")
  - module: String (e.g., "auth", "employee", "leave", "attendance", "payroll", "shift", "roster", "delegation", "policy")
  - userId: ObjectId (reference to users collection)
  - orgId: ObjectId (organization ID)
  - companyId: ObjectId (company ID)
  - unitId: ObjectId (unit ID)
  - target: { type: String, id: ObjectId, name: String, employeeId: String }
  - changes: Object (before/after values)
  - metadata: Object (additional context like ipAddress, userAgent)
  - timestamp: Date

User context:
- Role: ${role || 'unknown'}
- Organization: ${orgId || 'all'}
- Company: ${companyId || 'all'}
- Unit: ${unitId || 'all'}

RULES:
1. Use $match for filtering (ALWAYS include orgId/companyId/unitId based on user's scope)
2. Use $lookup to join with users collection for user details
3. Use $sort for ordering (default: timestamp -1)
4. Use $limit for pagination (default: 50)
5. Use $project to format output
6. Use $group for aggregations (count, sum, etc.)
7. Handle date ranges intelligently (today, this week, this month)
8. Include $facet for pagination metadata if needed

Examples:
Query: "Show me all logins today"
Response: [{"$match":{"action":"LOGIN","timestamp":{"$gte":"2024-01-15T00:00:00Z","$lt":"2024-01-16T00:00:00Z"}}},{"$lookup":{"from":"users","localField":"userId","foreignField":"_id","as":"user"}},{"$unwind":"$user"},{"$sort":{"timestamp":-1}},{"$limit":50}]

Query: "Count employee creations by department"
Response: [{"$match":{"action":"EMPLOYEE_CREATED"}},{"$lookup":{"from":"employees","localField":"target.id","foreignField":"_id","as":"employee"}},{"$unwind":"$employee"},{"$lookup":{"from":"departments","localField":"employee.departmentId","foreignField":"_id","as":"department"}},{"$unwind":"$department"},{"$group":{"_id":"$department.name","count":{"$sum":1}}},{"$sort":{"count":-1}}]

Query: "Show me failed login attempts"
Response: [{"$match":{"action":"LOGIN_FAILED"}},{"$lookup":{"from":"users","localField":"userId","foreignField":"_id","as":"user"}},{"$unwind":"$user"},{"$sort":{"timestamp":-1}},{"$limit":50}]

Now generate aggregation pipeline for this query: ${userQuery}`;

    try {
      const result = await this.getModel().generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: systemPrompt }]
        }],
        generationConfig: {
          temperature: 0.3,
          topK: 10,
          topP: 0.8,
          maxOutputTokens: 1024,
        }
      });

      const responseText = result.response.text();
      
      // Clean up response - remove markdown code blocks if present
      let cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      // Parse JSON
      const pipeline = JSON.parse(cleanedResponse);

      // Validate it's an array
      if (!Array.isArray(pipeline)) {
        throw new Error('Generated pipeline is not an array');
      }

      return {
        success: true,
        pipeline,
        explanation: await this.generateExplanation(userQuery, pipeline)
      };

    } catch (error) {
      console.error('Gemini API Error:', error);

      // Fallback to safe default pipeline
      return {
        success: false,
        error: error.message,
        pipeline: this.getFallbackPipeline(context),
        explanation: 'Using default query due to AI processing error.'
      };
    }
  }

  /**
   * Generate human-readable explanation of the aggregation pipeline
   */
  async generateExplanation(userQuery, pipeline) {
    const prompt = `Explain in 1-2 sentences what this MongoDB aggregation pipeline does for the query: "${userQuery}"

Pipeline: ${JSON.stringify(pipeline, null, 2)}

Keep it simple and user-friendly. No technical jargon.`;

    try {
      const result = await this.getModel().generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 100,
        }
      });

      return result.response.text().trim();
    } catch {
      return `Query executed for: ${userQuery}`;
    }
  }

  /**
   * Fallback pipeline when Gemini fails
   */
  getFallbackPipeline(context) {
    const matchStage = { $match: {} };

    // Add scoping based on user context
    if (context.orgId) matchStage.$match.orgId = context.orgId;
    if (context.companyId) matchStage.$match.companyId = context.companyId;
    if (context.unitId) matchStage.$match.unitId = context.unitId;

    return [
      matchStage,
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $sort: { timestamp: -1 } },
      { $limit: 50 }
    ];
  }

  /**
   * Generate natural language insights from audit log data
   */
  async generateInsights(data, query) {
    if (!data || data.length === 0) {
      return 'No data available for analysis.';
    }

    const prompt = `Analyze this audit log data and provide 2-3 key insights in bullet points.

Query: ${query}
Data summary: ${JSON.stringify(data.slice(0, 5), null, 2)}
Total records: ${data.length}

Focus on:
1. Patterns or trends
2. Anomalies or unusual activity
3. Actionable recommendations

Keep it concise and professional.`;

    try {
      const result = await this.getModel().generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 200,
        }
      });

      return result.response.text().trim();
    } catch (error) {
      console.error('Insight generation failed:', error);
      return 'Analysis unavailable. Please review the data manually.';
    }
  }

  /**
   * Suggest related queries based on current query
   */
  async suggestRelatedQueries(currentQuery, context) {
    const prompt = `Suggest 3 related audit log queries based on: "${currentQuery}"

Context: User is ${context.role} in an HRMS system.

Return ONLY a JSON array of 3 strings, no other text.
Example: ["Show failed logins this week", "Count logins by location", "List unauthorized access attempts"]`;

    try {
      const result = await this.getModel().generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 150,
        }
      });

      const responseText = result.response.text().trim();
      
      // Clean and parse
      let cleaned = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Query suggestion failed:', error);
      return [
        'Show recent activity logs',
        'Count actions by module',
        'List top active users'
      ];
    }
  }
}

module.exports = new GeminiService();