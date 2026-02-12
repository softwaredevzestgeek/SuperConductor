import path from 'path'
import { EverythingService } from '../EverythingService.js'
import { LoggerLike } from '@shared/api'

import { HookContext, feathers } from '@feathersjs/feathers'
import { koa, rest, bodyParser, errorHandler, serveStatic, cors } from '@feathersjs/koa'
import mount from 'koa-mount'
import socketio from '@feathersjs/socketio'
import { Rundown } from '../../models/rundown/Rundown.js'
import { ClientEventBus } from '../ClientEventBus.js'
import { RundownService, RUNDOWN_CHANNEL_PREFIX } from './RundownService.js'
import { LegacyService } from './LegacyService.js'
import { ReportingService } from './ReportingService.js'
import { PROJECTS_CHANNEL_PREFIX, ProjectService } from './ProjectService.js'
import { ClientMethods, ProjectsEvents, RundownsEvents, ServiceName, ServiceTypes } from '../../ipc/IPCAPI.js'
import { Project, ProjectBase } from '../../models/project/Project.js'
import { PartService } from './PartService.js'
import { GroupService } from './GroupService.js'
import { unReplaceUndefined } from '../../lib/util.js'

export class ApiServer {
	private app = koa<ServiceTypes>(feathers())
	readonly GUI_PATH = '/gui'

	constructor(
		app: Electron.App,
		public readonly port: number,
		ipcServer: EverythingService,
		clientEventBus: ClientEventBus,
		log: LoggerLike
	) {
		// Configure CORS for web interface access
		// In production/release mode, allow all origins for flexibility
		// In development, this is also permissive for local testing
		// TODO: Consider making this configurable via settings for production deployments
		const corsOrigin = app.isPackaged ? '*' : '*'
		this.app.use(
			cors({
				origin: corsOrigin,
				credentials: true,
			})
		)

		this.app.use(errorHandler())
		this.app.use(bodyParser())
		this.app.configure(rest())
		this.app.configure(socketio({ cors: { origin: corsOrigin, credentials: true } }))

		this.app.use(ServiceName.GROUPS, new GroupService(this.app, ipcServer, clientEventBus), {
			methods: ClientMethods[ServiceName.GROUPS],
			serviceEvents: [],
			events: [],
		})

		this.app.use(ServiceName.PROJECTS, new ProjectService(this.app, ipcServer, clientEventBus), {
			methods: ClientMethods[ServiceName.PROJECTS],
			serviceEvents: ['created', ProjectsEvents.UPDATED, 'deleted', ProjectsEvents.UNDO_LEDGERS_UPDATED],
		})

		this.app.use(ServiceName.PARTS, new PartService(this.app, ipcServer, clientEventBus), {
			methods: ClientMethods[ServiceName.PARTS],
			serviceEvents: [],
			events: [],
		})

		this.app.use(ServiceName.RUNDOWNS, new RundownService(this.app, ipcServer, clientEventBus), {
			// TODO: what if we made a base class for Services and made those arrays fields so that they live nearvy the implementation?
			methods: ClientMethods[ServiceName.RUNDOWNS],
			serviceEvents: ['created', RundownsEvents.UPDATED, 'deleted'],
		})

		this.app.use(ServiceName.REPORTING, new ReportingService(this.app, ipcServer), {
			methods: ClientMethods[ServiceName.REPORTING],
			serviceEvents: [],
			events: [],
		})

		// TODO: potentially may break some thing in ultra rare cases. Should we enable it only for selected methods?
		this.app.hooks({
			before: {
				all: [
					async (context: HookContext) => {
						context.data = unReplaceUndefined(context.data)
					},
				],
			},
		})

		this.app.service(ServiceName.RUNDOWNS).publish((data: Rundown, _context: HookContext) => {
			return this.app.channel(RUNDOWN_CHANNEL_PREFIX + data.id)
		})

		this.app
			.service(ServiceName.PROJECTS)
			.publish((_data: string | Project | ProjectBase, _context: HookContext) => {
				return this.app.channel(PROJECTS_CHANNEL_PREFIX)
			})

		// Serve the GUI from the build folder:
		{
			let guiUrlPath: string
			if (app.isPackaged) {
				// In production/packaged mode, build folder is in the app path
				guiUrlPath = path.resolve(app.getAppPath(), 'build')
			} else {
				// In development mode, build folder is relative to app path
				guiUrlPath = path.resolve(app.getAppPath(), '../build')
			}

			// Add redirect from /gui to /gui/ for proper asset loading (must be before static serving)
			this.app.use(async (ctx, next) => {
				if (ctx.path === this.GUI_PATH && !ctx.path.endsWith('/')) {
					ctx.redirect(`${this.GUI_PATH}/`)
					return
				}
				await next()
			})

			// Mount static files at /gui path
			this.app.use(mount(this.GUI_PATH, serveStatic(guiUrlPath)))
		}

		// --- legacy code, only for a rapid prototype
		this.app.use(
			ServiceName.LEGACY,
			new LegacyService(this.app, ipcServer, clientEventBus) as unknown as EverythingService,
			{
				methods: Object.getOwnPropertyNames(EverythingService.prototype).filter(
					(methodName) => !methodName.startsWith('_') && methodName !== 'constructor'
				) as (keyof EverythingService)[],
				events: ['callMethod'],
			}
		)
		this.app.on('connection', (connection) => {
			this.app.channel('everybody').join(connection)
			this.app.channel(PROJECTS_CHANNEL_PREFIX).join(connection) // TODO: use ids and remove this
		})
		this.app.service(ServiceName.LEGACY).publish(() => {
			return this.app.channel(`everybody`)
		})
		// ---- end legacy code

		// Bind to 0.0.0.0 to allow external access in production/release mode
		// This enables the web interface to be accessible from other devices on the network.
		// For development/test environments, this can be overridden with SC_GUI_BIND_ALL=1
		const bindHost = app.isPackaged || process.env.SC_GUI_BIND_ALL === '1' ? '0.0.0.0' : '127.0.0.1'
		this.app
			.listen(this.port, bindHost)
			.then(() => log.info(`Feathers server listening on ${bindHost}:${this.port}`))
			.catch(log.error)
	}
}
