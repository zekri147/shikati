import type { User } from '../env';
import type { AppModule } from './types';
import { chequesModule } from './cheques';
import { collectModule } from './collect';

export const modules: AppModule[] = [chequesModule, collectModule];

export const canUse = (m: AppModule, user: User) => m.roles.includes(user.role) && (!m.allow || m.allow(user));
