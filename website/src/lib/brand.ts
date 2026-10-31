import { brandLockupSvg, brandMarkSvg } from '../../../src/brand'

let next = 0
const gradientId = () => `ez-sunset-${++next}`

export const markSvg = () => brandMarkSvg(gradientId())

export const lockupSvg = (height: number) => brandLockupSvg({ height, id: gradientId() })
