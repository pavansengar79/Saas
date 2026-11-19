// modules/auditLogs/auditAnalytics.controller.js
// AI-Powered Audit Log Analytics Controller

const auditLogService = require('./auditLog.service');
const geminiService = require('../../utils/gemini.service');
const AppError = require('../../utils/appError');

/**
 * Execute natural language query using AI
 * POST /api/v1/audit-logs/analytics/query
 */
exports.executeQuery = async (req, res, next) => {
  try {
    const { query, module, action, limit = 50 } = req.body;

    if (!query) {
      return next(new AppError('Query is required', 400));
    }

    if (!geminiService.isConfigured) {
      return next(new AppError('AI audit analytics is not configured on this server', 503));
    }

    // Build context from authenticated user
    const context = {
      orgId: req.user.orgId,
      companyId: req.user.companyId,
      unitId: req.user.unitId,
      userId: req.user._id,
      role: req.user.role
    };

    // Generate aggregation pipeline via Gemini AI
    const aiResponse = await geminiService.generateAggregationPipeline(query, context);

    if (!aiResponse.success) {
      console.warn('[AuditAnalytics] AI pipeline generation failed, using fallback');
    }

    let pipeline = aiResponse.pipeline;

    // Override with explicit filters if provided
    if (module || action) {
      const matchIndex = pipeline.findIndex(stage => stage.$match);
      if (matchIndex !== -1) {
        if (module) pipeline[matchIndex].$match.module = module;
        if (action) pipeline[matchIndex].$match.action = action;
      } else {
        // Add match stage at the beginning
        const explicitMatch = { $match: {} };
        if (module) explicitMatch.$match.module = module;
        if (action) explicitMatch.$match.action = action;
        pipeline.unshift(explicitMatch);
      }
    }

    // Ensure proper scoping based on user role
    const scopeMatch = { $match: {} };
    
    // Apply data isolation based on role
    if (req.user.role !== 'SUPER_ADMIN') {
      scopeMatch.$match.orgId = req.user.orgId;
      
      if (['company_admin', 'unit_admin'].includes(req.user.role)) {
        scopeMatch.$match.companyId = req.user.companyId;
      }
      
      if (req.user.role === 'unit_admin') {
        scopeMatch.$match.unitId = req.user.unitId;
      }
    }

    // Merge scope match with first $match stage if exists
    const firstMatchIndex = pipeline.findIndex(stage => stage.$match);
    if (firstMatchIndex !== -1) {
      pipeline[firstMatchIndex].$match = {
        ...scopeMatch.$match,
        ...pipeline[firstMatchIndex].$match
      };
    } else {
      pipeline.unshift(scopeMatch);
    }

    // Apply limit
    const limitIndex = pipeline.findIndex(stage => stage.$limit);
    if (limitIndex !== -1) {
      if (Number.isInteger(limit) && limit > 0) {
        pipeline[limitIndex].$limit = parseInt(limit);
      }
    }

    // Execute aggregation
    const AuditLog = require('../../models/auditLog.model');
    const results = await AuditLog.aggregate(pipeline).allowDiskUse(true);
    
    // Populate user details if not already in pipeline
    const populatedResults = await AuditLog.populate(results, {
      path: 'userId',
      select: 'name email role avatar firstName lastName'
    });

    // Generate insights
    const insights = await geminiService.generateInsights(results, query);

    // Generate related queries
    const relatedQueries = await geminiService.suggestRelatedQueries(query, context);

    // Log this analytics query
    await auditLogService.createLog({
      action: 'ANALYTICS_QUERY',
      module: 'auditLog',
      userId: req.user._id,
      orgId: req.user.orgId,
      companyId: req.user.companyId,
      unitId: req.user.unitId,
      target: {
        type: 'AnalyticsQuery',
        id: null,
        name: query
      },
      metadata: {
        query,
        module: module || 'all',
        action: action || 'all',
        resultCount: results.length,
        pipelineUsed: aiResponse.success
      }
    });

    res.json({
      success: true,
      data: {
        results: populatedResults,
        insights,
        relatedQueries,
        explanation: aiResponse.explanation,
        queryExecuted: query,
        filters: { module, action, limit },
        timestamp: new Date(),
        totalResults: populatedResults.length
      }
    });

  } catch (error) {
    console.error('[AuditAnalytics] Error:', error);
    next(new AppError('Failed to execute analytics query', 500));
  }
};

/**
 * Get available modules and actions for filtering
 * GET /api/v1/audit-logs/analytics/metadata
 */
exports.getMetadata = async (req, res, next) => {
  try {
    const AuditLog = require('../../models/auditLog.model');

    // Get distinct modules
    const modules = await AuditLog.distinct('module');

    // Get actions grouped by module
    const actionsByModule = await AuditLog.aggregate([
      {
        $group: {
          _id: '$module',
          actions: { $addToSet: '$action' }
        }
      },
      {
        $project: {
          module: '$_id',
          actions: 1,
          _id: 0
        }
      },
      { $sort: { module: 1 } }
    ]);

    res.json({
      success: true,
      data: {
        modules,
        actionsByModule,
        totalModules: modules.length
      }
    });

  } catch (error) {
    next(new AppError('Failed to fetch metadata', 500));
  }
};

/**
 * Get dashboard stats for audit logs
 * GET /api/v1/audit-logs/analytics/dashboard
 */
exports.getDashboard = async (req, res, next) => {
  try {
    const AuditLog = require('../../models/auditLog.model');
    const { startDate, endDate } = req.query;

    const dateMatch = {};
    if (startDate || endDate) {
      dateMatch.timestamp = {};
      if (startDate) dateMatch.timestamp.$gte = new Date(startDate);
      if (endDate) dateMatch.timestamp.$lte = new Date(endDate);
    }

    // Apply scoping
    const scopeMatch = { ...dateMatch };
    if (req.user.role !== 'SUPER_ADMIN') {
      scopeMatch.orgId = req.user.orgId;
      if (['company_admin', 'unit_admin'].includes(req.user.role)) {
        scopeMatch.companyId = req.user.companyId;
      }
      if (req.user.role === 'unit_admin') {
        scopeMatch.unitId = req.user.unitId;
      }
    }

    // Total logs count
    const totalLogs = await AuditLog.countDocuments(scopeMatch);

    // Logs by module
    const logsByModule = await AuditLog.aggregate([
      { $match: scopeMatch },
      {
        $group: {
          _id: '$module',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    // Logs by action (top 10)
    const logsByAction = await AuditLog.aggregate([
      { $match: scopeMatch },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Recent activity (last 24 hours)
    const last24Hours = new Date();
    last24Hours.setHours(last24Hours.getHours() - 24);

    const recentActivity = await AuditLog.aggregate([
      {
        $match: {
          ...scopeMatch,
          timestamp: { $gte: last24Hours }
        }
      },
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
      { $limit: 20 }
    ]);

    // Activity timeline (by hour for last 24 hours)
    const timeline = await AuditLog.aggregate([
      {
        $match: {
          ...scopeMatch,
          timestamp: { $gte: last24Hours }
        }
      },
      {
        $group: {
          _id: {
            hour: { $hour: '$timestamp' },
            module: '$module'
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: '$_id.hour',
          modules: {
            $push: {
              module: '$_id.module',
              count: '$count'
            }
          },
          total: { $sum: '$count' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      success: true,
      data: {
        totalLogs,
        logsByModule,
        logsByAction,
        recentActivity,
        timeline,
        dateRange: {
          start: startDate || 'All time',
          end: endDate || 'Now'
        }
      }
    });

  } catch (error) {
    console.error('[AuditDashboard] Error:', error);
    next(new AppError('Failed to fetch dashboard data', 500));
  }
};